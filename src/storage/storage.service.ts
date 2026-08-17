import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { createS3Client } from './s3-client.factory';

export interface PresignedUpload {
  url: string;
  /** The client must send exactly this Content-Type; see the note on signing below. */
  contentType: string;
  expiresAt: Date;
}

export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

export interface StoredObject {
  sizeBytes: number;
  contentType?: string;
  etag?: string;
}

/**
 * The only module that talks to S3.
 *
 * Bytes never pass through this API: the browser PUTs straight to S3 with a presigned URL
 * and reads through a short-lived presigned GET. Upload throughput is therefore independent
 * of how many API instances are running, and a 50 MB upload never occupies a request
 * handler.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = createS3Client(config);
  }

  /**
   * Signs a URL the browser can PUT to.
   *
   * `signableHeaders` is the part worth reading. Passing `ContentType` to the command is
   * **not** enough on its own: the v3 presigner hoists it out of the signature, leaving
   * `X-Amz-SignedHeaders=host`, and any client can then upload with any content type
   * (verified by inspecting a signed URL and by uploading a mismatch, which succeeded).
   * Asking for it explicitly puts `content-type` into the signature, so a mismatch is
   * rejected by the store rather than accepted quietly.
   *
   * That is why the exact value is returned to the caller instead of being derived again on
   * the client: `application/pdf` and `application/pdf; charset=utf-8` produce different
   * signatures, and the failure surfaces as an opaque 403.
   *
   * The stored content type is never trusted at read time regardless — downloads pin their
   * own — so this is defence in depth rather than the only line.
   *
   * `ContentLength` is deliberately left unsigned: a one-byte difference between the
   * declared and actual size would invalidate the signature, and the browser is not the
   * authority on the size anyway. The real size is verified afterwards with a HEAD.
   */
  async presignUpload(params: {
    key: string;
    contentType: string;
  }): Promise<PresignedUpload> {
    const expiresIn = this.config.presignPutTtlSeconds;
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.s3.bucket,
        Key: params.key,
        ContentType: params.contentType,
      }),
      { expiresIn, signableHeaders: new Set(['content-type']) },
    );

    return {
      url,
      contentType: params.contentType,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  /**
   * Signs a short-lived URL for reading one object.
   *
   * The filename and content type are pinned here rather than taken from what was stored:
   * the stored type came from the client, and trusting it at read time would let an
   * uploaded HTML file be served as HTML from the bucket's origin. Only PDFs are served
   * inline; everything else downloads.
   */
  async presignDownload(params: {
    key: string;
    fileName: string;
    contentType: string;
    disposition: 'inline' | 'attachment';
  }): Promise<PresignedDownload> {
    const expiresIn = this.config.presignGetTtlSeconds;
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.s3.bucket,
        Key: params.key,
        ResponseContentType: params.contentType,
        ResponseContentDisposition: contentDisposition(params.disposition, params.fileName),
        ResponseCacheControl: 'private, max-age=60',
      }),
      { expiresIn },
    );

    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  /** Returns undefined when the object is absent, which is how an unfinished upload looks. */
  async head(key: string): Promise<StoredObject | undefined> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.s3.bucket, Key: key }),
      );
      return {
        sizeBytes: Number(response.ContentLength ?? 0),
        contentType: response.ContentType,
        etag: response.ETag?.replaceAll('"', ''),
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 404 || status === 403) return undefined;
      throw error;
    }
  }

  /**
   * Best-effort deletion. Returns the keys that were removed so the caller can clear only
   * those from its queue — a key that failed stays queued and is retried, because the
   * alternative is a deleted document quietly remaining in the bucket.
   */
  async deleteObjects(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const deleted: string[] = [];

    // S3 accepts at most 1000 keys per request.
    for (let offset = 0; offset < keys.length; offset += 1000) {
      const batch = keys.slice(offset, offset + 1000);
      const response = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.config.s3.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
        }),
      );

      for (const item of response.Deleted ?? []) {
        if (item.Key) deleted.push(item.Key);
      }
      for (const error of response.Errors ?? []) {
        this.logger.warn(`Failed to delete ${error.Key ?? 'unknown key'}: ${error.Message ?? ''}`);
      }
    }

    return deleted;
  }
}

/**
 * Builds a Content-Disposition header that survives non-ASCII names.
 *
 * A raw UTF-8 filename in the quoted form is mangled or dropped by browsers, so RFC 5987's
 * `filename*` carries the real name and the plain `filename` keeps an ASCII fallback for
 * anything that cannot read it.
 */
export function contentDisposition(
  disposition: 'inline' | 'attachment',
  fileName: string,
): string {
  const asciiFallback = fileName.replaceAll(/[^\x20-\x7e]/g, '_').replaceAll(/["\\]/g, '_');
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

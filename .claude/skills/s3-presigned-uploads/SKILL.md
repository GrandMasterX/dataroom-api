---
name: s3-presigned-uploads
description: Correct browser-direct uploads and downloads with AWS S3 (and MinIO for local parity) — SigV4 presigning rules that decide whether a browser PUT works at all, required CORS configuration, bucket security settings that must NOT be enabled because they break presigned PUT, object key design, Content-Disposition and filename encoding for downloads, presigned GET as a bearer credential, and orphan-object garbage collection. Use whenever you touch upload/download code, the S3 client or StorageService, bucket policy or CORS, MinIO in docker-compose, or when a PUT fails with SignatureDoesNotMatch or 403, a download has the wrong filename, or a PDF downloads instead of rendering.
---

# S3 presigned uploads and downloads

Bytes never pass through the API: the browser PUTs straight to S3 with a presigned URL, and reads through
a short-lived presigned GET. That is the right architecture — the API stays stateless and upload
throughput is independent of it — but presigning has a handful of rules that turn a working upload into
`SignatureDoesNotMatch` if you get them wrong. They are listed first because that is the order in which
they bite.

## Signing rules

- **Passing `ContentType` to the command does not sign it.** This is the opposite of what most
  write-ups claim, and it is worth checking rather than believing: with the AWS SDK v3 presigner the
  resulting URL carries `X-Amz-SignedHeaders=host`, and a PUT with *any* content type — or none —
  succeeds. Verified by reading the query string of a signed URL and by uploading four different
  content types against one signature, all accepted.

  To actually bind it, opt in: `getSignedUrl(client, command, { expiresIn, signableHeaders: new
  Set(['content-type']) })`. Then the client must send exactly the value the presign endpoint
  returned — `application/pdf; charset=utf-8` against a signature for `application/pdf` fails — so
  return that value and have the client echo it rather than deriving it again.

  Decide deliberately which you want. Binding it is defence in depth, not a substitute for pinning
  the type at read time: the stored content type came from the client either way.
- **Do not sign `ContentLength`.** A one-byte difference between the declared and actual size invalidates
  the signature, and the browser is not the authority on the size anyway. Verify the real size after the
  fact with `HeadObject` and reject the completion if it disagrees with what was declared.
- **Do not add extra headers "for safety".** Every signed header is a new way for the request to be
  rejected, and the failure surfaces as an opaque 403 in the browser console.
- SigV4 presigned URLs are valid for at most 7 days; use minutes, not days. A short PUT window (about 15
  minutes) and a shorter GET window (about 5) limit the blast radius of a leaked URL.

## Bucket configuration

Required for a browser to PUT and GET at all:

```json
[{ "AllowedOrigins": ["<app origins>"], "AllowedMethods": ["PUT", "GET", "HEAD"],
   "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3000 }]
```

Without `ExposeHeaders: ["ETag"]` the client cannot read the ETag even though the response contains it —
CORS hides it. Without the origin listed, the browser fails the preflight and the network tab shows a
CORS error rather than an S3 error, which sends people debugging the wrong layer.

Security settings that are correct here: Block Public Access on all four flags, ACLs disabled
(`BucketOwnerEnforced`), default SSE, a policy denying non-TLS requests, and a lifecycle rule aborting
incomplete multipart uploads after a day.

**The trap:** do **not** add a policy statement denying uploads that lack an
`x-amz-server-side-encryption` header. A browser PUT does not send that header, so the statement turns
every upload into a 403 — while default bucket encryption already encrypts the object. This is a
"hardening" change that breaks the product without improving anything; if you see it proposed, reject it
with this reason.

## Object keys

Derive keys entirely from server-generated ids — for example `rooms/{roomId}/{nodeId}/{versionId}` — and
never from user-supplied names. Three properties follow for free:

1. Path traversal and unicode/case collisions are structurally impossible.
2. Renaming a file is a metadata-only update; no object copy, no risk of a half-renamed state.
3. A new version is a new key, so the previous version's bytes are never overwritten.

## Downloads and viewing

- The user-facing filename is applied at read time through the signed
  `response-content-disposition` parameter, so it always reflects the current name rather than the name at
  upload time. Because the parameter is part of the signature, a client cannot tamper with it.
- Non-ASCII filenames need RFC 5987 encoding (`filename*=UTF-8''<percent-encoded>`); a raw Cyrillic name in
  the header produces a mangled or dropped filename.
- Use `inline` only for content you intend to render (PDF here) and `attachment` for everything else.
  Serving arbitrary uploaded content inline lets an uploaded HTML file execute on the storage origin —
  that is why non-PDF types are always attachments.
- Prefer an endpoint that returns `{ url, expiresAt }` over a 302 redirect: the client can refresh the URL
  before it expires, and no proxy layer has to be taught to forward `Location`.

## Orphans and cleanup

A presign that is never completed leaves an object with no database row. Track the intent to upload in the
database, and garbage-collect by listing expired unconsumed intents — not by scanning the bucket, which
costs money and grows with the data. The reverse ordering matters too: delete rows in the transaction and
objects only **after** commit. An orphaned object is recoverable and cheap; an object deleted for a
transaction that rolled back is lost data.

## Local parity with MinIO

One code path for both environments; only configuration differs. MinIO needs `forcePathStyle: true` and an
explicit endpoint, real S3 needs neither.

The failure that costs an hour: if the API runs inside Docker and signs URLs against the internal hostname
(`http://minio:9000`), the browser on the host cannot resolve it. Either run the API on the host so both
sides agree on `localhost:9000`, or keep separate internal and public endpoints and sign with the public
one. Decide this deliberately rather than discovering it.

Build the S3 client without hardcoded credentials so the SDK's provider chain applies — env vars locally,
an instance/task role in production. Then moving off static keys is a deployment change, not a code change.

## Verification

CORS, signature composition and disposition behaviour cannot be verified by reading code; they are
properties of the real service. Test uploads and downloads against the actual MinIO container, and after
changing bucket configuration in production, confirm with a real presigned PUT from a browser origin
rather than a CLI call — the CLI does not exercise CORS at all.

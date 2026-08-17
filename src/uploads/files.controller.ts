import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessService } from '../access/access.service';
import { Ctx, type AccessContext } from '../auth/access-context';
import { DomainError } from '../common/errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { FileVersionDto, PreviewUrlDto } from './dto/upload.dto';
import { dispositionFor } from './supported-types';

@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly access: AccessService,
  ) {}

  @Get(':nodeId/preview-url')
  @ApiOperation({
    summary: 'A short-lived signed URL for viewing or downloading the current version',
    description:
      'Returns JSON rather than redirecting: the client knows when the URL expires and can fetch a new one before it does, and no proxy layer has to be taught to forward a Location header.',
  })
  @ApiOkResponse({ type: PreviewUrlDto })
  async previewUrl(
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Ctx() ctx: AccessContext,
  ): Promise<PreviewUrlDto> {
    const { node } = await this.access.require(ctx, nodeId, 'read');
    if (node.type !== 'FILE') throw DomainError.notFound('Not a file');

    const version = await this.prisma.fileVersion.findFirstOrThrow({
      where: { nodeId: node.id, isCurrent: true },
    });

    const disposition = dispositionFor(version.mimeType);
    const signed = await this.storage.presignDownload({
      key: version.storageKey,
      // The current name, not the name at upload time: renaming a file must change what a
      // download is called, and it does because the name is applied when the URL is signed.
      fileName: node.name,
      contentType: version.mimeType,
      disposition,
    });

    return {
      url: signed.url,
      expiresAt: signed.expiresAt,
      disposition,
      fileName: node.name,
      mimeType: version.mimeType,
      sizeBytes: Number(version.sizeBytes),
    };
  }

  @Get(':nodeId/versions')
  @ApiOperation({
    summary: 'Version history',
    description:
      'Owners only. The history names the people who uploaded each version, which is internal information about the seller’s team rather than something a guest needs.',
  })
  @ApiOkResponse({ type: [FileVersionDto] })
  async versions(
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Ctx() ctx: AccessContext,
  ): Promise<FileVersionDto[]> {
    const { node } = await this.access.require(ctx, nodeId, 'viewVersionHistory');

    const versions = await this.prisma.fileVersion.findMany({
      where: { nodeId: node.id },
      orderBy: { versionNumber: 'desc' },
      include: { createdBy: { select: { displayName: true } } },
    });

    return versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      isCurrent: version.isCurrent,
      sizeBytes: Number(version.sizeBytes),
      createdAt: version.createdAt,
      createdBy: version.createdBy.displayName,
    }));
  }
}

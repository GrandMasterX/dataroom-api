import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessService } from '../access/access.service';
import { Ctx, CurrentUser, type AccessContext } from '../auth/access-context';
import { RequireUser } from '../auth/access-context.guard';
import {
  CompleteUploadDto,
  PresignBatchDto,
  PresignBatchResultDto,
  UploadResultDto,
} from './dto/upload.dto';
import { UploadsService } from './uploads.service';

@ApiTags('uploads')
@Controller('uploads')
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly access: AccessService,
  ) {}

  @Post('presign')
  @RequireUser()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get signed URLs for a batch of files',
    description:
      'The browser then PUTs each file directly to storage, so bytes never pass through this API and upload throughput does not depend on it. Any name collisions are reported here, before the bytes are sent.',
  })
  @ApiOkResponse({ type: PresignBatchResultDto })
  async presign(
    @Body() dto: PresignBatchDto,
    @Ctx() ctx: AccessContext,
    @CurrentUser() user: { id: string },
  ): Promise<PresignBatchResultDto> {
    const { node } = await this.access.require(ctx, dto.parentId, 'upload');
    return this.uploads.presign(user.id, node, dto);
  }

  @Post('complete')
  @RequireUser()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register an uploaded object as a file',
    description:
      'Idempotent: repeating a completed upload returns the same result. A conflict does not consume the upload, so the client can answer differently without sending the bytes again.',
  })
  @ApiOkResponse({ type: UploadResultDto })
  complete(
    @Body() dto: CompleteUploadDto,
    @CurrentUser() user: { id: string },
  ): Promise<UploadResultDto> {
    // Access was checked when the URL was signed, and the upload is bound to that user;
    // re-checking the folder here would fail legitimately-completed uploads whenever a
    // share was adjusted mid-transfer.
    return this.uploads.complete(user.id, dto);
  }
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { NameRules } from '../../common/validation/name-rules';
import { NodeDto } from '../../nodes/dto/node.dto';

export class PresignItemDto {
  @ApiProperty({ example: 'Q1 2026 Accounts.pdf' })
  @NameRules()
  fileName!: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  mimeType!: string;

  @ApiProperty({ description: 'Declared size; verified against the stored object afterwards' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}

export class PresignBatchDto {
  @ApiProperty() @IsUUID() parentId!: string;

  @ApiProperty({
    type: [PresignItemDto],
    description:
      'Batched deliberately: one request per file would collide with this API’s own rate limit the first time someone drags in a folder.',
  })
  @ValidateNested({ each: true })
  @Type(() => PresignItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  items!: PresignItemDto[];
}

export class UploadConflictDto {
  @ApiProperty() existingNodeId!: string;
  @ApiProperty({
    enum: ['FOLDER', 'FILE'],
    description:
      'A collision with a folder cannot be resolved by adding a version — the UI needs this to avoid offering a dead option.',
  })
  existingType!: 'FOLDER' | 'FILE';
  @ApiProperty({ description: 'Versions the existing file already has' })
  versionCount!: number;
}

export class PresignedItemDto {
  @ApiProperty() intentId!: string;
  @ApiProperty() uploadUrl!: string;
  @ApiProperty({ description: 'Send exactly this Content-Type or the signature will not match' })
  contentType!: string;
  @ApiProperty() expiresAt!: Date;
  @ApiPropertyOptional({
    type: UploadConflictDto,
    description: 'Advisory: reported before the bytes are sent so the user is asked first.',
  })
  conflict?: UploadConflictDto;
}

export class PresignBatchResultDto {
  @ApiProperty({ type: [PresignedItemDto] }) items!: PresignedItemDto[];
}

export class CompleteUploadDto {
  @ApiProperty() @IsUUID() intentId!: string;

  @ApiPropertyOptional({
    enum: ['fail', 'rename', 'newVersion'],
    default: 'fail',
    description:
      '"newVersion" adds a version to the colliding file instead of creating a second one.',
  })
  @IsOptional()
  @IsIn(['fail', 'rename', 'newVersion'])
  onConflict?: 'fail' | 'rename' | 'newVersion';
}

export class UploadResultDto {
  @ApiProperty({ type: NodeDto }) node!: NodeDto;
  @ApiProperty() versionNumber!: number;
  @ApiProperty() sizeBytes!: number;
}

export class PreviewUrlDto {
  @ApiProperty({ description: 'Short-lived, signed; fetch a new one before it expires' })
  url!: string;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty({ enum: ['inline', 'attachment'] }) disposition!: 'inline' | 'attachment';
  @ApiProperty() fileName!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
}

export class FileVersionDto {
  @ApiProperty() id!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty() isCurrent!: boolean;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ description: 'Who uploaded it — owners only' }) createdBy!: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsEmail, IsOptional, MaxLength } from 'class-validator';

export class CreateShareLinkDto {
  @ApiPropertyOptional({
    description: 'Optional expiry. Without one the link lives until it is revoked.',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class CreateShareGrantDto {
  @ApiProperty({
    example: 'counsel@beacon.com',
    description:
      'The invitee does not need an account yet: access is resolved by address when they sign in.',
  })
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;
}

export class ShareLinkDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Build the public URL as <app>/s/<token>' }) token!: string;
  @ApiProperty() nodeId!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) expiresAt!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class ShareGrantDto {
  @ApiProperty() id!: string;
  @ApiProperty() nodeId!: string;
  @ApiProperty() email!: string;
  @ApiProperty() createdAt!: Date;
}

export class NodeSharesDto {
  @ApiPropertyOptional({
    type: ShareLinkDto,
    nullable: true,
    description: 'At most one active link per item, so the interface has one thing to copy.',
  })
  link!: ShareLinkDto | null;

  @ApiProperty({ type: [ShareGrantDto] }) grants!: ShareGrantDto[];
}

/**
 * What a link holder is told before they open anything.
 *
 * Deliberately no data room name and no ancestor information: those sit above the shared
 * node, and a link to "03 Legal / NDAs" must not reveal that the deal it belongs to exists.
 */
export class SharedLinkContextDto {
  @ApiProperty() nodeId!: string;
  @ApiProperty() nodeName!: string;
  @ApiProperty({ enum: ['FOLDER', 'FILE'] }) nodeType!: 'FOLDER' | 'FILE';
}

export class SharedWithMeItemDto {
  @ApiProperty() nodeId!: string;
  @ApiProperty() nodeName!: string;
  @ApiProperty({ enum: ['FOLDER', 'FILE'] }) nodeType!: 'FOLDER' | 'FILE';
  @ApiProperty() dataRoomId!: string;
  @ApiProperty({ description: 'Who shared it' }) sharedBy!: string;
  @ApiProperty() sharedAt!: Date;
}

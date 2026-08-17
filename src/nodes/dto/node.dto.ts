import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { NameRules } from '../../common/validation/name-rules';
import { can, type Role } from '../../access/permissions';
import type { ListedNode, NodeRow, SearchHit, SubtreeStats } from '../node-tree.service';

export class CreateFolderDto {
  @ApiProperty() @IsUUID() parentId!: string;

  @ApiProperty({ example: '03 Legal' })
  @NameRules()
  name!: string;

  @ApiPropertyOptional({
    enum: ['fail', 'rename'],
    default: 'fail',
    description:
      '"fail" reports a conflict so the UI can ask; "rename" keeps both by appending a counter.',
  })
  @IsOptional()
  @IsIn(['fail', 'rename'])
  onConflict?: 'fail' | 'rename';
}

export class RenameNodeDto {
  @ApiProperty()
  @NameRules()
  name!: string;

  @ApiPropertyOptional({ enum: ['fail', 'rename'], default: 'fail' })
  @IsOptional()
  @IsIn(['fail', 'rename'])
  onConflict?: 'fail' | 'rename';
}

export class MoveNodeDto {
  @ApiProperty() @IsUUID() targetParentId!: string;

  @ApiPropertyOptional({ enum: ['fail', 'rename'], default: 'fail' })
  @IsOptional()
  @IsIn(['fail', 'rename'])
  onConflict?: 'fail' | 'rename';
}

export class ListChildrenQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ enum: ['FOLDER', 'FILE'] })
  @IsOptional()
  @IsIn(['FOLDER', 'FILE'])
  type?: 'FOLDER' | 'FILE';
}

export class NodeDto {
  @ApiProperty() id!: string;
  @ApiProperty() dataRoomId!: string;
  @ApiProperty({ nullable: true, type: String }) parentId!: string | null;
  @ApiProperty({ enum: ['FOLDER', 'FILE'] }) type!: 'FOLDER' | 'FILE';
  @ApiProperty() name!: string;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional({ nullable: true, type: Number, description: 'Current version size' })
  sizeBytes?: number | null;
  @ApiPropertyOptional({ nullable: true, type: String })
  mimeType?: string | null;
}

export class BreadcrumbDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}

/**
 * What this actor may do here, decided server-side from the permission matrix.
 *
 * The frontend renders from these flags instead of re-deriving them from a role, so the
 * rule lives in exactly one place — and a guest never sees a control that would 403.
 */
export class CapabilitiesDto {
  @ApiProperty() canCreate!: boolean;
  @ApiProperty() canRename!: boolean;
  @ApiProperty() canMove!: boolean;
  @ApiProperty() canDelete!: boolean;
  @ApiProperty() canUpload!: boolean;
  @ApiProperty() canShare!: boolean;
  @ApiProperty() canViewVersionHistory!: boolean;
}

export class NodeDetailDto {
  @ApiProperty({ type: NodeDto }) node!: NodeDto;
  @ApiProperty({ type: [BreadcrumbDto], description: 'Root first; truncated for guests' })
  breadcrumbs!: BreadcrumbDto[];
  @ApiProperty({ type: CapabilitiesDto }) capabilities!: CapabilitiesDto;
}

export class ChildrenPageDto {
  @ApiProperty({ type: [NodeDto] }) items!: NodeDto[];
  @ApiPropertyOptional({ description: 'Absent when this is the last page' })
  nextCursor?: string;
}

export class SearchQueryDto {
  @ApiProperty({
    minLength: 3,
    description:
      'At least three characters: shorter queries produce no complete trigrams, so the index cannot serve them and every keystroke would scan the room.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  q!: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/**
 * Standalone rather than extending NodeDto: a search result carries the folder it was found
 * in, and redeclaring an inherited field to add documentation is the kind of subtlety that
 * makes a generated client harder to read than the extra six lines.
 */
export class SearchHitDto {
  @ApiProperty() id!: string;
  @ApiProperty() dataRoomId!: string;
  @ApiProperty({ enum: ['FOLDER', 'FILE'] }) type!: 'FOLDER' | 'FILE';
  @ApiProperty() name!: string;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional({ nullable: true, type: Number }) sizeBytes?: number | null;
  @ApiPropertyOptional({ nullable: true, type: String }) mimeType?: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'The folder this result sits in' })
  parentId!: string | null;
  @ApiProperty({ nullable: true, type: String }) parentName!: string | null;
}

export class SubtreeStatsDto {
  @ApiProperty() folderCount!: number;
  @ApiProperty() fileCount!: number;
  @ApiProperty({ description: 'Sum of current versions — the logical size' })
  totalSizeBytes!: number;
}

export function toNodeDto(node: NodeRow): NodeDto {
  // Explicit mapping, never the entity itself: a Prisma model carries fields that must not
  // reach a client (storage keys, hashes), and a column added later would leak by default.
  return {
    id: node.id,
    dataRoomId: node.dataRoomId,
    parentId: node.parentId,
    type: node.type,
    name: node.name,
    updatedAt: node.updatedAt,
  };
}

export function listedToNodeDto(item: ListedNode, dataRoomId: string, parentId: string): NodeDto {
  return {
    id: item.id,
    dataRoomId,
    parentId,
    type: item.type,
    name: item.name,
    updatedAt: item.updatedAt,
    sizeBytes: item.sizeBytes,
    mimeType: item.mimeType,
  };
}

export function toSearchHitDto(hit: SearchHit, dataRoomId: string): SearchHitDto {
  return {
    id: hit.id,
    dataRoomId,
    parentId: hit.parentId,
    parentName: hit.parentName,
    type: hit.type,
    name: hit.name,
    updatedAt: hit.updatedAt,
    sizeBytes: hit.sizeBytes,
    mimeType: hit.mimeType,
  };
}

export function toStatsDto(stats: SubtreeStats): SubtreeStatsDto {
  return stats;
}

export function toCapabilitiesDto(role: Role): CapabilitiesDto {
  return {
    canCreate: can('create', role),
    canRename: can('rename', role),
    canMove: can('move', role),
    canDelete: can('delete', role),
    canUpload: can('upload', role),
    canShare: can('share', role),
    canViewVersionHistory: can('viewVersionHistory', role),
  };
}

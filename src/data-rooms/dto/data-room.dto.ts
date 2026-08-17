import { ApiProperty } from '@nestjs/swagger';
import { NameRules } from '../../common/validation/name-rules';
import type { DataRoomSummary } from '../data-rooms.service';

export class CreateDataRoomDto {
  @ApiProperty({ example: 'Project Beacon' })
  @NameRules()
  name!: string;
}

export class DataRoomDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'The name of the room’s root node' }) name!: string;
  @ApiProperty({ description: 'Open this node to browse the room' }) rootNodeId!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export function toDataRoomDto(room: DataRoomSummary): DataRoomDto {
  return room;
}

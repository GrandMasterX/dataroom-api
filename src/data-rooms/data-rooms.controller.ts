import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessService } from '../access/access.service';
import { Ctx, CurrentUser, type AccessContext } from '../auth/access-context';
import { RequireUser } from '../auth/access-context.guard';
import { RenameNodeDto } from '../nodes/dto/node.dto';
import { NodeTreeService } from '../nodes/node-tree.service';
import { DataRoomsService } from './data-rooms.service';
import { CreateDataRoomDto, DataRoomDto, toDataRoomDto } from './dto/data-room.dto';

@ApiTags('data-rooms')
@Controller('data-rooms')
export class DataRoomsController {
  constructor(
    private readonly rooms: DataRoomsService,
    private readonly tree: NodeTreeService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequireUser()
  @ApiOperation({ summary: 'Data rooms owned by the caller' })
  @ApiOkResponse({ type: [DataRoomDto] })
  async list(@CurrentUser() user: { id: string }): Promise<DataRoomDto[]> {
    return (await this.rooms.listOwned(user.id)).map(toDataRoomDto);
  }

  @Post()
  @RequireUser()
  @ApiOkResponse({ type: DataRoomDto })
  async create(
    @Body() dto: CreateDataRoomDto,
    @CurrentUser() user: { id: string },
  ): Promise<DataRoomDto> {
    return toDataRoomDto(await this.rooms.create(user.id, dto.name));
  }

  // Declared after the static routes above; a ':id' route placed first would swallow them.
  @Get(':id')
  @ApiOkResponse({ type: DataRoomDto })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @Ctx() ctx: AccessContext,
  ): Promise<DataRoomDto> {
    await this.access.requireRoom(ctx, id, 'read');
    return toDataRoomDto(await this.rooms.get(id));
  }

  @Patch(':id')
  @RequireUser()
  @ApiOperation({
    summary: 'Rename a data room',
    description: 'Renames the room’s root node, which is where the name lives.',
  })
  @ApiOkResponse({ type: DataRoomDto })
  async rename(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameNodeDto,
    @Ctx() ctx: AccessContext,
  ): Promise<DataRoomDto> {
    const { node } = await this.access.requireRoom(ctx, id, 'rename');
    await this.tree.rename({ nodeId: node.id, name: dto.name, onConflict: 'fail' });
    return toDataRoomDto(await this.rooms.get(id));
  }

  @Delete(':id')
  @RequireUser()
  @ApiOperation({
    summary: 'Delete a data room and everything in it',
    description: 'Runs through the same subtree deletion as any folder, so blobs are queued too.',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Ctx() ctx: AccessContext,
  ): Promise<{ deletedItems: number }> {
    await this.access.requireRoom(ctx, id, 'delete');
    return this.rooms.remove(id);
  }
}

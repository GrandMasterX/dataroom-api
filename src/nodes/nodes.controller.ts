import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessService } from '../access/access.service';
import { projectBreadcrumbs, projectNode } from '../access/project-for-access-root';
import { Ctx, CurrentUser, type AccessContext } from '../auth/access-context';
import { RequireUser } from '../auth/access-context.guard';
import {
  ChildrenPageDto,
  CreateFolderDto,
  ListChildrenQueryDto,
  MoveNodeDto,
  NodeDetailDto,
  NodeDto,
  RenameNodeDto,
  SearchHitDto,
  SearchQueryDto,
  SubtreeStatsDto,
  listedToNodeDto,
  toCapabilitiesDto,
  toNodeDto,
  toSearchHitDto,
  toStatsDto,
} from './dto/node.dto';
import { NodeTreeService } from './node-tree.service';

/**
 * Folders and files share these endpoints because they share a table. "Share a data room"
 * is the same code path as "share a folder", and so is renaming, moving and deleting.
 *
 * Read endpoints are not marked @RequireUser: the same controller serves a guest holding a
 * share token. A second, guest-only read API would be a second copy of the same state
 * machine, and copies drift.
 */
@ApiTags('nodes')
@Controller('nodes')
export class NodesController {
  constructor(
    private readonly tree: NodeTreeService,
    private readonly access: AccessService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Node metadata with breadcrumbs and what the caller may do' })
  @ApiOkResponse({ type: NodeDetailDto })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Ctx() ctx: AccessContext,
  ): Promise<NodeDetailDto> {
    const access = await this.access.requireRead(ctx, id);
    return {
      // Projected, not raw: at the edge of a share the parent exists but must not be named.
      node: projectNode(toNodeDto(access.node), access),
      breadcrumbs: projectBreadcrumbs(await this.tree.breadcrumbs(access.node), access),
      capabilities: toCapabilitiesDto(access.role),
    };
  }

  @Get(':id/children')
  @ApiOperation({
    summary: 'One page of a folder’s contents',
    description:
      'Keyset pagination: pass the previous page’s cursor. Ordered folders first, then by name, case-insensitively.',
  })
  @ApiOkResponse({ type: ChildrenPageDto })
  async children(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListChildrenQueryDto,
    @Ctx() ctx: AccessContext,
  ): Promise<ChildrenPageDto> {
    const { node } = await this.access.requireRead(ctx, id);
    const page = await this.tree.listChildren({
      parentId: node.id,
      limit: query.limit ?? 50,
      cursor: query.cursor,
      type: query.type,
    });

    return {
      items: page.items.map((item) => listedToNodeDto(item, node.dataRoomId, node.id)),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':id/stats')
  @ApiOperation({
    summary: 'Totals for everything under this node',
    description:
      'Used by the folder header and by the delete confirmation, so the warning states what will actually be removed.',
  })
  @ApiOkResponse({ type: SubtreeStatsDto })
  async stats(
    @Param('id', ParseUUIDPipe) id: string,
    @Ctx() ctx: AccessContext,
  ): Promise<SubtreeStatsDto> {
    const { node } = await this.access.requireRead(ctx, id);
    return toStatsDto(await this.tree.stats(node.id));
  }

  @Get(':id/search')
  @ApiOperation({
    summary: 'Find items by name inside this subtree',
    description:
      'Scoped to the node it is called on, so a guest searching a shared folder cannot reach anything outside it — the same endpoint serves both without a separate rule.',
  })
  @ApiOkResponse({ type: [SearchHitDto] })
  async search(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: SearchQueryDto,
    @Ctx() ctx: AccessContext,
  ): Promise<SearchHitDto[]> {
    const { node } = await this.access.requireRead(ctx, id);
    const hits = await this.tree.search({ node, query: query.q, limit: query.limit ?? 20 });
    return hits.map((hit) => toSearchHitDto(hit, node.dataRoomId));
  }

  @Post('folders')
  @RequireUser()
  @ApiOkResponse({ type: NodeDto })
  async createFolder(
    @Body() dto: CreateFolderDto,
    @Ctx() ctx: AccessContext,
    @CurrentUser() user: { id: string },
  ): Promise<NodeDto> {
    await this.access.require(ctx, dto.parentId, 'create');
    const folder = await this.tree.createFolder({
      actorId: user.id,
      parentId: dto.parentId,
      name: dto.name,
      onConflict: dto.onConflict ?? 'fail',
    });
    return toNodeDto(folder);
  }

  @Patch(':id')
  @RequireUser()
  @ApiOperation({ summary: 'Rename. Renaming a data room’s root renames the room.' })
  @ApiOkResponse({ type: NodeDto })
  async rename(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameNodeDto,
    @Ctx() ctx: AccessContext,
  ): Promise<NodeDto> {
    await this.access.require(ctx, id, 'rename');
    const renamed = await this.tree.rename({
      nodeId: id,
      name: dto.name,
      onConflict: dto.onConflict ?? 'fail',
    });
    return toNodeDto(renamed);
  }

  @Post(':id/move')
  @RequireUser()
  @ApiOkResponse({ type: NodeDto })
  async move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveNodeDto,
    @Ctx() ctx: AccessContext,
  ): Promise<NodeDto> {
    // Both ends are checked: moving out of a folder you may write and into one you may not
    // would otherwise be a way to relocate documents into someone else's room.
    await this.access.require(ctx, id, 'move');
    await this.access.require(ctx, dto.targetParentId, 'create');

    const moved = await this.tree.move({
      nodeId: id,
      targetParentId: dto.targetParentId,
      onConflict: dto.onConflict ?? 'fail',
    });
    return toNodeDto(moved);
  }

  @Delete(':id')
  @RequireUser()
  @ApiOperation({
    summary: 'Delete a node and everything under it',
    description:
      'Storage objects are queued for removal in the same transaction and deleted afterwards.',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Ctx() ctx: AccessContext,
  ): Promise<{ deletedItems: number }> {
    const { node } = await this.access.require(ctx, id, 'delete');
    const result = await this.tree.deleteSubtree(node.id);
    return { deletedItems: result.deletedNodes };
  }
}

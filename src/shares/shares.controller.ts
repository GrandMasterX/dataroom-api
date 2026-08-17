import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessService } from '../access/access.service';
import { Ctx, CurrentUser, type AccessContext } from '../auth/access-context';
import { RequireUser } from '../auth/access-context.guard';
import {
  CreateShareGrantDto,
  CreateShareLinkDto,
  NodeSharesDto,
  ShareGrantDto,
  ShareLinkDto,
  SharedLinkContextDto,
  SharedWithMeItemDto,
} from './dto/share.dto';
import { SharesService } from './shares.service';

@ApiTags('shares')
@Controller()
export class SharesController {
  constructor(
    private readonly shares: SharesService,
    private readonly access: AccessService,
  ) {}

  @Get('nodes/:id/shares')
  @RequireUser()
  @ApiOperation({ summary: 'Who can currently see this item' })
  @ApiOkResponse({ type: NodeSharesDto })
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @Ctx() ctx: AccessContext,
  ): Promise<NodeSharesDto> {
    await this.access.require(ctx, id, 'share');
    return this.shares.listForNode(id);
  }

  @Post('nodes/:id/shares/link')
  @RequireUser()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create or return the public link for an item',
    description:
      'Idempotent: an item has at most one active link, so pressing share twice cannot leave a second URL that the owner never sees and cannot revoke.',
  })
  @ApiOkResponse({ type: ShareLinkDto })
  async createLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateShareLinkDto,
    @Ctx() ctx: AccessContext,
    @CurrentUser() user: { id: string },
  ): Promise<ShareLinkDto> {
    const { node } = await this.access.require(ctx, id, 'share');
    return this.shares.createOrGetLink({
      nodeId: node.id,
      dataRoomId: node.dataRoomId,
      actorId: user.id,
      expiresAt: dto.expiresAt,
    });
  }

  @Delete('shares/links/:linkId')
  @RequireUser()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke a public link',
    description:
      'Takes effect on the next request: access is re-resolved every time and never cached in a session.',
  })
  async revokeLink(
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Ctx() ctx: AccessContext,
  ): Promise<void> {
    // Authorised against the shared item, not against the share row: holding a share id is
    // not itself a capability.
    await this.access.require(ctx, await this.shares.nodeIdForLink(linkId), 'share');
    await this.shares.revokeLink(linkId);
  }

  @Post('nodes/:id/shares/grants')
  @RequireUser()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Give a specific person read access',
    description:
      'By email address, so someone who has not registered yet can be invited; access resolves when they sign in. Re-inviting a revoked person reinstates the same grant.',
  })
  @ApiOkResponse({ type: ShareGrantDto })
  async grant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateShareGrantDto,
    @Ctx() ctx: AccessContext,
    @CurrentUser() user: { id: string; email: string },
  ): Promise<ShareGrantDto> {
    const { node } = await this.access.require(ctx, id, 'share');
    return this.shares.grantAccess({
      nodeId: node.id,
      dataRoomId: node.dataRoomId,
      actorId: user.id,
      actorEmail: user.email,
      email: dto.email,
    });
  }

  @Delete('shares/grants/:grantId')
  @RequireUser()
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeGrant(
    @Param('grantId', ParseUUIDPipe) grantId: string,
    @Ctx() ctx: AccessContext,
  ): Promise<void> {
    await this.access.require(ctx, await this.shares.nodeIdForGrant(grantId), 'share');
    await this.shares.revokeGrant(grantId);
  }

  @Get('shared/:token')
  @ApiOperation({
    summary: 'What a public link points at',
    description:
      'Public by design — the token is the credential. Answers only about the shared item: naming its data room or its ancestors would defeat truncating them everywhere else.',
  })
  @ApiOkResponse({ type: SharedLinkContextDto })
  resolveLink(@Param('token') token: string): Promise<SharedLinkContextDto> {
    return this.shares.resolveLink(token);
  }

  @Get('shared-with-me')
  @RequireUser()
  @ApiOperation({ summary: 'Items other people have shared with the caller' })
  @ApiOkResponse({ type: [SharedWithMeItemDto] })
  sharedWithMe(@CurrentUser() user: { email: string }): Promise<SharedWithMeItemDto[]> {
    return this.shares.sharedWithMe(user.email);
  }

  @Get('invites/:grantId')
  @RequireUser()
  @ApiOperation({
    summary: 'Resolve an invitation link',
    description:
      'No email is sent by this service, so the owner copies a link and passes it on. It resolves only for the invited address.',
  })
  @ApiOkResponse({ type: SharedWithMeItemDto })
  invite(
    @Param('grantId', ParseUUIDPipe) grantId: string,
    @CurrentUser() user: { email: string },
  ): Promise<SharedWithMeItemDto> {
    return this.shares.inviteContext(grantId, user.email);
  }

}

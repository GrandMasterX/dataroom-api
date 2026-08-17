import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '../common/errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';
import type {
  NodeSharesDto,
  ShareGrantDto,
  ShareLinkDto,
  SharedLinkContextDto,
  SharedWithMeItemDto,
} from './dto/share.dto';

@Injectable()
export class SharesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the item's active link, creating one if there is none.
   *
   * Creating is idempotent because the interface offers a single "share link" for an item:
   * pressing it twice must not silently produce a second URL that the owner cannot see and
   * cannot revoke. A partial unique index enforces the same rule in the database.
   */
  async createOrGetLink(params: {
    nodeId: string;
    dataRoomId: string;
    actorId: string;
    expiresAt?: string;
  }): Promise<ShareLinkDto> {
    const existing = await this.prisma.shareLink.findFirst({
      where: { nodeId: params.nodeId, revokedAt: null },
    });
    if (existing) return toLinkDto(existing);

    const link = await this.prisma.shareLink.create({
      data: {
        nodeId: params.nodeId,
        dataRoomId: params.dataRoomId,
        // 32 bytes of randomness: the token is the credential, so guessing must be
        // hopeless. Stored in the clear so the owner can copy it again after a reload —
        // hashing would only protect against a database dump, which already exposes the
        // documents themselves.
        token: randomBytes(24).toString('base64url'),
        expiresAt: params.expiresAt ? new Date(params.expiresAt) : null,
        createdById: params.actorId,
      },
    });
    return toLinkDto(link);
  }

  /**
   * The item a share belongs to, so the caller can be authorised against that item rather
   * than against the share row. Holding a share id must not by itself allow revoking it.
   */
  async nodeIdForLink(linkId: string): Promise<string> {
    const link = await this.prisma.shareLink.findUnique({
      where: { id: linkId },
      select: { nodeId: true },
    });
    if (!link) throw DomainError.notFound('Share not found');
    return link.nodeId;
  }

  async nodeIdForGrant(grantId: string): Promise<string> {
    const grant = await this.prisma.shareGrant.findUnique({
      where: { id: grantId },
      select: { nodeId: true },
    });
    if (!grant) throw DomainError.notFound('Share not found');
    return grant.nodeId;
  }

  /** Revoking twice is not an error: the caller's intent is already satisfied. */
  async revokeLink(linkId: string): Promise<void> {
    await this.prisma.shareLink.updateMany({
      where: { id: linkId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Grants read access to an email address.
   *
   * Re-inviting someone who was revoked reinstates the original grant rather than adding a
   * second row: the owner's mental model is "this person has access", not "this person has
   * three grants". The unique index on (node, email) makes that the only possible outcome.
   */
  async grantAccess(params: {
    nodeId: string;
    dataRoomId: string;
    actorId: string;
    email: string;
    actorEmail: string;
  }): Promise<ShareGrantDto> {
    if (params.email === params.actorEmail) {
      throw DomainError.forbidden('You already have access to this item');
    }

    const grant = await this.prisma.shareGrant.upsert({
      where: { nodeId_inviteeEmail: { nodeId: params.nodeId, inviteeEmail: params.email } },
      create: {
        nodeId: params.nodeId,
        dataRoomId: params.dataRoomId,
        inviteeEmail: params.email,
        createdById: params.actorId,
      },
      update: { revokedAt: null },
    });

    return toGrantDto(grant);
  }

  async revokeGrant(grantId: string): Promise<void> {
    await this.prisma.shareGrant.updateMany({
      where: { id: grantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async listForNode(nodeId: string): Promise<NodeSharesDto> {
    const [link, grants] = await Promise.all([
      this.prisma.shareLink.findFirst({ where: { nodeId, revokedAt: null } }),
      this.prisma.shareGrant.findMany({
        where: { nodeId, revokedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return { link: link ? toLinkDto(link) : null, grants: grants.map(toGrantDto) };
  }

  /**
   * Resolves a public link for someone who has not opened anything yet.
   *
   * Answers only about the shared node. Naming the data room or any ancestor here would
   * defeat the point of truncating them everywhere else.
   */
  async resolveLink(token: string): Promise<SharedLinkContextDto> {
    const link = await this.prisma.shareLink.findUnique({
      where: { token },
      include: { node: { select: { id: true, name: true, type: true } } },
    });

    const isUsable =
      link && link.revokedAt === null && (link.expiresAt === null || link.expiresAt > new Date());
    // A revoked, expired or unknown token are one and the same answer: telling them apart
    // would confirm that a link once existed.
    if (!isUsable) throw DomainError.notFound('This link is no longer available');

    return { nodeId: link.node.id, nodeName: link.node.name, nodeType: link.node.type };
  }

  /** Everything shared with this address — the entry point for an invited guest. */
  async sharedWithMe(email: string): Promise<SharedWithMeItemDto[]> {
    const grants = await this.prisma.shareGrant.findMany({
      where: { inviteeEmail: email, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        node: { select: { id: true, name: true, type: true } },
        // The sharer's display name is shown to the guest; that person deliberately
        // revealed themselves by sharing.
        dataRoom: { select: { id: true, owner: { select: { displayName: true } } } },
      },
    });

    return grants.map((grant) => ({
      nodeId: grant.node.id,
      nodeName: grant.node.name,
      nodeType: grant.node.type,
      dataRoomId: grant.dataRoom.id,
      sharedBy: grant.dataRoom.owner.displayName,
      sharedAt: grant.createdAt,
    }));
  }

  /**
   * Context for an invite link the owner copied and sent by hand.
   *
   * Resolves only for the invited address. Without that check the endpoint would tell
   * anyone holding a grant id which document was shared and with whom.
   */
  async inviteContext(grantId: string, viewerEmail: string): Promise<SharedWithMeItemDto> {
    const grant = await this.prisma.shareGrant.findUnique({
      where: { id: grantId },
      include: {
        node: { select: { id: true, name: true, type: true } },
        dataRoom: { select: { id: true, owner: { select: { displayName: true } } } },
      },
    });

    if (!grant || grant.revokedAt !== null || grant.inviteeEmail !== viewerEmail) {
      throw DomainError.notFound('This invitation is no longer available');
    }

    return {
      nodeId: grant.node.id,
      nodeName: grant.node.name,
      nodeType: grant.node.type,
      dataRoomId: grant.dataRoom.id,
      sharedBy: grant.dataRoom.owner.displayName,
      sharedAt: grant.createdAt,
    };
  }
}

function toLinkDto(link: {
  id: string;
  token: string;
  nodeId: string;
  expiresAt: Date | null;
  createdAt: Date;
}): ShareLinkDto {
  return {
    id: link.id,
    token: link.token,
    nodeId: link.nodeId,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    createdAt: link.createdAt,
  };
}

function toGrantDto(grant: {
  id: string;
  nodeId: string;
  inviteeEmail: string;
  createdAt: Date;
}): ShareGrantDto {
  return {
    id: grant.id,
    nodeId: grant.nodeId,
    email: grant.inviteeEmail,
    createdAt: grant.createdAt,
  };
}

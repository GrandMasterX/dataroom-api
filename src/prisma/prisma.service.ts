import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    // Prisma 7 requires a driver adapter. A consequence worth remembering: the pool
    // size is a pg.Pool option here, not a `connection_limit` query parameter — the
    // old URL-based recipe silently does nothing now.
    //
    // The pool is deliberately larger than one connection. The single-connection
    // recipe belongs to serverless functions; in a long-lived container one
    // interactive transaction would block every other request on the instance.
    super({
      adapter: new PrismaPg({
        connectionString: config.databaseUrl,
        max: config.dbPoolMax,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Serializes tree mutations within one data room.
   *
   * Move and subtree delete depend on no other mutation restructuring the tree
   * underneath them; without this, "move A into B" and "move B into A" can both pass
   * validation and produce a detached cycle. Creating and renaming do NOT need this —
   * they allocate names atomically with INSERT ... ON CONFLICT DO NOTHING, and taking a
   * room-wide lock per uploaded file would turn a multi-file upload into a queue.
   *
   * The lock is transaction-scoped, so there is no unlock path to forget.
   */
  async lockDataRoomTree(tx: PrismaTransaction, dataRoomId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${dataRoomId}, 0))`;
  }
}

/**
 * Options for transactions that do real work: moving a subtree, deleting one, completing an
 * upload.
 *
 * Prisma's defaults are five seconds to finish and two to acquire a connection, which is
 * generous for a single insert and thin for a statement that rewrites thousands of rows while
 * holding a room-wide advisory lock — especially on a cold database or a shared instance,
 * where the failure is a P2028 the user reads as "it broke" rather than "it took too long".
 *
 * Deliberately not unbounded: a transaction that cannot finish in half a minute is stuck, and
 * holding the lock longer would block every other write in that room.
 */
export const TREE_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/** The transaction-scoped client handed to callbacks by `$transaction`. */
export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$transaction' | '$on' | '$use' | '$extends'
>;

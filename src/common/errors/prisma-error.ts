/**
 * Identifies which database constraint a Prisma error came from.
 *
 * `P2002` on its own is not actionable: several different unique indexes can raise it, and
 * reporting "that name is taken" for a violated single-root or single-current-version
 * index would be simply wrong. Prisma's top-level message never names the index — with the
 * pg driver adapter the name is only available on the nested driver error, so this is the
 * one place that knows the shape.
 */

export const UNIQUE_VIOLATION = 'P2002';

interface PrismaLikeError {
  code?: string;
  meta?: {
    driverAdapterError?: {
      cause?: {
        originalMessage?: string;
        constraint?: { fields?: string[] };
      };
    };
  };
}

export function isUniqueViolation(error: unknown, indexName?: string): boolean {
  const err = error as PrismaLikeError;
  if (err?.code !== UNIQUE_VIOLATION) return false;
  if (!indexName) return true;
  return violatedConstraintName(error) === indexName;
}

export function violatedConstraintName(error: unknown): string | undefined {
  const originalMessage = (error as PrismaLikeError)?.meta?.driverAdapterError?.cause
    ?.originalMessage;
  return originalMessage?.match(/unique constraint "([^"]+)"/)?.[1];
}

/** Index names referenced by error mapping, kept next to the code that interprets them. */
export const UniqueIndex = {
  nodeNameInFolder: 'nodes_parent_id_name_ci_key',
  singleRootPerRoom: 'nodes_single_root_key',
  singleCurrentVersion: 'file_versions_one_current',
  oneActiveShareLink: 'share_links_one_active',
  userEmail: 'users_email_key',
} as const;

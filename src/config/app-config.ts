/**
 * Every environment variable this service needs, validated once at boot.
 *
 * The point of failing here is that a missing S3_BUCKET should break the deploy, not
 * the first upload a user attempts. Nothing outside this file reads process.env, so the
 * complete set of required variables is greppable in one place.
 */
export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly corsOrigins: string[];

  readonly databaseUrl: string;
  readonly dbPoolMax: number;

  readonly jwtAccessSecret: string;
  readonly jwtRefreshSecret: string;
  readonly accessTokenTtl: string;
  readonly refreshTokenTtlDays: number;
  readonly refreshRotationGraceSeconds: number;

  readonly s3: {
    readonly bucket: string;
    readonly region: string;
    /** Set for MinIO; empty for real AWS S3, where the SDK derives the endpoint. */
    readonly endpoint?: string;
    readonly forcePathStyle: boolean;
    /**
     * Explicit keys, or undefined to let the SDK's provider chain resolve them (which
     * is what an assumed IAM role needs). See s3-client.factory.ts for why these are
     * not the standard AWS_* variable names.
     */
    readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
  };

  readonly uploadMaxBytes: number;
  readonly presignPutTtlSeconds: number;
  readonly presignGetTtlSeconds: number;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) {
      problems.push(`${key} is required`);
      return '';
    }
    return value;
  };

  const positiveInt = (key: string, fallback?: number): number => {
    const raw = env[key]?.trim();
    if (!raw) {
      if (fallback !== undefined) return fallback;
      problems.push(`${key} is required`);
      return 0;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      problems.push(`${key} must be a positive integer, got "${raw}"`);
      return 0;
    }
    return parsed;
  };

  const nodeEnv = (env.NODE_ENV?.trim() || 'development') as AppConfig['nodeEnv'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    problems.push(`NODE_ENV must be development | test | production, got "${nodeEnv}"`);
  }

  const config: AppConfig = {
    nodeEnv,
    port: positiveInt('PORT', 4000),
    // An empty allowlist would silently accept no browser origin at all, which is
    // indistinguishable from a broken deploy — so require it explicitly.
    corsOrigins: required('CORS_ORIGINS')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),

    databaseUrl: required('DATABASE_URL'),
    dbPoolMax: positiveInt('DB_POOL_MAX', 10),

    jwtAccessSecret: required('JWT_ACCESS_SECRET'),
    jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
    accessTokenTtl: env.ACCESS_TOKEN_TTL?.trim() || '15m',
    refreshTokenTtlDays: positiveInt('REFRESH_TOKEN_TTL_DAYS', 7),
    refreshRotationGraceSeconds: positiveInt('REFRESH_ROTATION_GRACE_SECONDS', 10),

    s3: {
      bucket: required('S3_BUCKET'),
      region: required('S3_REGION'),
      endpoint: env.S3_ENDPOINT?.trim() || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE?.trim() === 'true',
      credentials: s3Credentials(env, problems),
    },

    uploadMaxBytes: positiveInt('UPLOAD_MAX_BYTES', 52_428_800),
    presignPutTtlSeconds: positiveInt('PRESIGN_PUT_TTL_SECONDS', 900),
    presignGetTtlSeconds: positiveInt('PRESIGN_GET_TTL_SECONDS', 300),
  };

  // MinIO needs path-style addressing; real S3 does not. Catching the mismatch here
  // beats debugging a 403 from a presigned URL later.
  if (config.s3.endpoint && !config.s3.forcePathStyle) {
    problems.push('S3_FORCE_PATH_STYLE must be "true" when S3_ENDPOINT is set (MinIO)');
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/**
 * Both keys or neither. A half-configured pair would silently fall through to the SDK's
 * provider chain and could end up using whatever credentials the host happens to have —
 * which, for a local run pointed at MinIO, could mean writing to a real S3 bucket.
 */
function s3Credentials(
  env: NodeJS.ProcessEnv,
  problems: string[],
): AppConfig['s3']['credentials'] {
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();

  if (accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey };
  if (accessKeyId || secretAccessKey) {
    problems.push('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together, or both omitted');
  }
  // A local endpoint with no explicit keys means MinIO would be addressed with whatever
  // ambient AWS credentials exist — a confusing failure at best.
  if (!accessKeyId && !secretAccessKey && env.S3_ENDPOINT?.trim()) {
    problems.push('S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are required when S3_ENDPOINT is set');
  }
  return undefined;
}

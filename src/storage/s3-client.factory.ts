import { S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '../config/app-config';

/**
 * Single place where an S3 client is constructed, so local MinIO and production S3
 * cannot drift apart in configuration.
 *
 * Credentials are read from S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY — deliberately NOT
 * from the standard AWS_* names. The AWS SDK's provider chain puts ambient environment
 * variables ahead of anything a .env file loads, and dotenv never overrides variables
 * that are already set. A developer with AWS keys exported in their shell would
 * therefore have those keys used instead of the local MinIO ones. The harmless version
 * of that is a confusing 403; the dangerous version is a local run writing into a real
 * S3 bucket. Distinct names make the mix-up impossible.
 *
 * When the two variables are absent the SDK's default chain applies, which is what a
 * deployment using an assumed IAM role wants — so moving off static keys is a
 * configuration change, not a code change.
 */
export function createS3Client(config: AppConfig): S3Client {
  return new S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: config.s3.credentials,
  });
}

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Re-exported so consumers can type S3 handles without depending on the AWS SDK directly.
export type { S3Client } from '@aws-sdk/client-s3';

// Re-exported so consumers can type S3 handles without depending on the AWS SDK directly.
export type { S3Client } from '@aws-sdk/client-s3';

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Required for MinIO-style path-addressed buckets. */
  forcePathStyle?: boolean;
}

export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/** Presigned PUT URL so clients upload directly to object storage, never through the API process. */
export async function presignPutObject(
  client: S3Client,
  bucket: string,
  key: string,
  contentType: string,
  expiresInSeconds: number,
): Promise<string> {
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

export async function getObjectBuffer(client: S3Client, bucket: string, key: string): Promise<Buffer> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) {
    throw new Error(`S3 object "${key}" returned an empty body`);
  }
  const bytes = await response.Body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

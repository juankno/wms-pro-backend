import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { isSafeKey, keyFromPublicUrl, ObjectStorage } from './object-storage';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  publicUrl: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

// Works with AWS S3 and S3-compatible services (Cloudflare R2, MinIO) through `endpoint`.
export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: Boolean(config.endpoint),
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
          : undefined,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.assertSafe(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    this.assertSafe(key);
    const { Body } = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    if (!Body) throw new Error(`Empty object: ${key}`);
    return Buffer.from(await Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    this.assertSafe(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  publicUrl(key: string): string {
    return `${this.config.publicUrl.replace(/\/+$/, '')}/${key}`;
  }

  keyFromUrl(url: string): string | null {
    return keyFromPublicUrl(url, this.config.publicUrl);
  }

  private assertSafe(key: string) {
    if (!isSafeKey(key)) throw new Error(`Unsafe storage key: ${key}`);
  }
}

import { LocalStorage } from './local-storage';
import { ObjectStorage } from './object-storage';
import { S3Storage } from './s3-storage';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required when STORAGE_DRIVER=s3`);
  return value;
}

export function createObjectStorage(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  if (env.STORAGE_DRIVER === 's3') {
    return new S3Storage({
      bucket: required(env, 'S3_BUCKET'),
      region: env.S3_REGION ?? 'auto',
      publicUrl: required(env, 'S3_PUBLIC_URL'),
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    });
  }

  const apiBase = env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 3000}/${env.API_PREFIX ?? 'v1'}`;
  return new LocalStorage(env.UPLOAD_DIR ?? './uploads', `${apiBase}/uploads`);
}

import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { requireTenantId } from '../tenancy/tenant-context';
import { OBJECT_STORAGE, type ObjectStorage } from './storage/object-storage';

const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);
const MAX_DIMENSION = 1600;
const WEBP_QUALITY = 82;

const tenantPrefix = (tenantId: string) => `tenants/${tenantId}/`;

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  // Re-encoding to WebP validates the real content, normalizes orientation and drops EXIF (e.g. GPS).
  async saveFile(buffer: Buffer): Promise<{ url: string; id: string }> {
    const image = await this.toWebp(buffer);
    const id = randomUUID().replace(/-/g, '');
    const key = `${tenantPrefix(requireTenantId())}photos/${id}.webp`;

    await this.storage.put(key, image, 'image/webp');
    return { id, url: this.storage.publicUrl(key) };
  }

  // Only files inside the current tenant prefix can be removed.
  async deleteFile(url: string): Promise<void> {
    const key = this.storage.keyFromUrl(url);
    if (!key?.startsWith(tenantPrefix(requireTenantId()))) return;
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn(`Could not delete ${key}: ${String(error)}`);
    }
  }

  private async toWebp(buffer: Buffer): Promise<Buffer> {
    try {
      const pipeline = sharp(buffer, { failOn: 'error' });
      const { format } = await pipeline.metadata();
      if (!format || !ALLOWED_FORMATS.has(format)) throw new Error(`Unsupported format: ${format}`);
      return await pipeline
        .rotate()
        .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
    } catch {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'El archivo no es una imagen válida. Use JPEG, PNG o WebP.',
      });
    }
  }
}

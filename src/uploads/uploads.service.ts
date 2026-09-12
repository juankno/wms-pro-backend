import { Injectable, BadRequestException } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

@Injectable()
export class UploadsService {
  private readonly uploadDir = process.env.UPLOAD_DIR ?? './uploads';

  ensureDir() {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  getPublicUrl(filename: string): string {
    const prefix = process.env.API_PREFIX ?? 'v1';
    const base =
      process.env.PUBLIC_URL ??
      `http://localhost:${process.env.PORT ?? 3000}/${prefix}`;
    return `${base}/uploads/${filename}`;
  }

  deleteFile(url: string): void {
    try {
      const filename = url.split('/').pop()?.split('?')[0];
      if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) return;
      const filepath = path.resolve(this.uploadDir, filename);
      if (!filepath.startsWith(path.resolve(this.uploadDir) + path.sep)) return;
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    } catch {
      // No-op: borrado de archivo es no-crítico
    }
  }

  async saveFile(
    buffer: Buffer,
    _originalname: string,
    mimetype: string,
  ): Promise<{ url: string; id: string }> {
    if (!ALLOWED_MIMES.has(mimetype)) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'Formato de imagen no permitido. Use JPEG, PNG o WebP.',
      });
    }

    this.ensureDir();

    // Derive extension from MIME only — never trust originalname (path traversal prevention)
    const ext = MIME_TO_EXT[mimetype] ?? '.jpg';
    const id = `photo_${uuidv4().replace(/-/g, '')}`;
    const filename = `${id}${ext}`;
    const filepath = path.join(this.uploadDir, filename);

    fs.writeFileSync(filepath, buffer);

    return { id, url: this.getPublicUrl(filename) };
  }
}

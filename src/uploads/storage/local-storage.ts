import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isSafeKey, keyFromPublicUrl, ObjectStorage } from './object-storage';

export class LocalStorage implements ObjectStorage {
  private readonly root: string;

  constructor(
    rootDir: string,
    private readonly baseUrl: string,
  ) {
    this.root = path.resolve(rootDir);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  publicUrl(key: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/${key}`;
  }

  keyFromUrl(url: string): string | null {
    return keyFromPublicUrl(url, this.baseUrl);
  }

  private resolve(key: string): string {
    const file = path.resolve(this.root, key);
    if (!isSafeKey(key) || !file.startsWith(this.root + path.sep)) {
      throw new Error(`Unsafe storage key: ${key}`);
    }
    return file;
  }
}

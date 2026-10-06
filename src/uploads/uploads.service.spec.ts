import { BadRequestException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInTenant } from '../tenancy/tenant-context';
import { LocalStorage } from './storage/local-storage';
import { isSafeKey, keyFromPublicUrl } from './storage/object-storage';
import { UploadsService } from './uploads.service';

const BASE_URL = 'http://api.test/v1/uploads';

const photo = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .jpeg()
    .withExif({ IFD0: { Make: 'TestCam', Model: 'GPS-Phone' } })
    .toBuffer();

describe('storage keys', () => {
  it.each(['tenants/t1/photos/a.webp', 'legacy.jpg'])('accepts %s', (key) => {
    expect(isSafeKey(key)).toBe(true);
  });

  it.each(['../etc/passwd', 'tenants//x', '/abs', 'tenants/../x', 'a b'])('rejects %s', (key) => {
    expect(isSafeKey(key)).toBe(false);
  });

  it('maps public URLs back to keys only under the base URL', () => {
    expect(keyFromPublicUrl(`${BASE_URL}/tenants/t1/photos/a.webp?v=1`, BASE_URL)).toBe('tenants/t1/photos/a.webp');
    expect(keyFromPublicUrl('https://evil.test/tenants/t1/a.webp', BASE_URL)).toBeNull();
    expect(keyFromPublicUrl(`${BASE_URL}/..%2F..%2Fsecret`, BASE_URL)).toBeNull();
  });
});

describe('UploadsService with local storage', () => {
  let root: string;
  let uploads: UploadsService;
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runInTenant(tenantId, fn);
  const fileOf = (url: string) => path.join(root, url.slice(BASE_URL.length + 1));

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wms-uploads-'));
    uploads = new UploadsService(new LocalStorage(root, BASE_URL));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('stores a resized WebP without EXIF under the tenant prefix', async () => {
    const { url } = await inTenant('tenant-a', async () => uploads.saveFile(await photo(3000, 1500)));

    expect(url).toMatch(new RegExp(`^${BASE_URL}/tenants/tenant-a/photos/[0-9a-f]{32}\\.webp$`));
    const stored = await sharp(await readFile(fileOf(url))).metadata();
    expect(stored).toMatchObject({ format: 'webp', width: 1600, height: 800 });
    expect(stored.exif).toBeUndefined();
  });

  it('rejects content that is not an image', async () => {
    await expect(inTenant('tenant-a', () => uploads.saveFile(Buffer.from('not an image')))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('deletes only files of the current tenant', async () => {
    const { url } = await inTenant('tenant-a', async () => uploads.saveFile(await photo(10, 10)));

    await inTenant('tenant-b', () => uploads.deleteFile(url));
    await expect(readFile(fileOf(url))).resolves.toBeDefined();

    await inTenant('tenant-a', () => uploads.deleteFile(url));
    await expect(readFile(fileOf(url))).rejects.toThrow();
  });
});

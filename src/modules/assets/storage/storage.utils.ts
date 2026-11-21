import crypto from 'crypto';
import path from 'path';

import { STORAGE_ERROR_CODES } from './storage.constants.js';
import { AssetStorageError } from './storage.error.js';
import type { StoragePath } from './storage.types.js';

export function slugify(value: string): string {
  if (!value) {
    return 'file';
  }

  const slug = value
    .normalize('NFKD')

    // remove accent characters
    .replace(/[\u0300-\u036f]/g, '')

    .toLowerCase()
    .trim()

    // & -> and
    .replace(/&/g, ' and ')

    // remove unsafe URL characters
    .replace(/[^a-z0-9\s-_]/g, '')

    // spaces/underscore -> -
    .replace(/[\s_]+/g, '-')

    // collapse multiple -
    .replace(/-+/g, '-')

    .replace(/^-|-$/g, '');

  return slug || 'file';
}

export function sanitizePathSegment(value: string): string {
  return slugify(value);
}

export function buildStorageFolder(storagePath: StoragePath): string {
  const segments = [storagePath.module, storagePath.entity, storagePath.category]
    .filter(Boolean)
    .map((segment) => sanitizePathSegment(segment as string));

  if (segments.length === 0) {
    throw new AssetStorageError(
      'At least a module is required to build the storage path',
      STORAGE_ERROR_CODES.INVALID_PATH,
      400,
    );
  }

  return segments.join('/');
}

export function getFileExtension(originalName: string): string | null {
  const extension = path.extname(originalName).toLowerCase();

  if (!extension) {
    return null;
  }

  // Protect against weird/injected extensions
  if (!/^\.[a-z0-9]{1,20}$/.test(extension)) {
    return null;
  }

  return extension;
}

export function createSeoFileName(seoName: string, originalName: string): string {
  const slug = slugify(seoName);

  const uuid = crypto.randomUUID();

  const extension = getFileExtension(originalName) ?? '';

  return `${slug}--${uuid}${extension}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 Bytes';
  }

  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const index = Math.floor(Math.log(bytes) / Math.log(1024));

  return `${(bytes / Math.pow(1024, index)).toFixed(2)} ${units[index]}`;
}

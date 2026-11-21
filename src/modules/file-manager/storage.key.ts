import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StorageError } from './storage.errors.js';

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, '');

export const sanitizeFolder = (folder: string): string => {
  const normalized = trimSlashes(folder.trim().replace(/\\/g, '/'));

  if (!normalized || normalized.includes('..')) {
    throw new StorageError('Invalid storage folder', 'INVALID_STORAGE_KEY');
  }

  return normalized
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '-'))
    .join('/');
};

export const sanitizeFilename = (filename: string): string => {
  const base = path.basename(filename).trim();
  const extension = path.extname(base).toLowerCase();
  const name = path
    .basename(base, extension)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/[._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);

  return `${name || 'file'}${extension}`;
};

export const getExtension = (filename: string): string =>
  path.extname(filename).replace(/^\./, '').toLowerCase();

export interface CreateStorageKeyOptions {
  /**
   * Puts the descriptive filename first so image URLs remain readable:
   * `black-running-shoes-a1b2c3d4.webp`.
   */
  seoFriendly?: boolean;
}

export const createStorageKey = (
  folder: string,
  originalName: string,
  requestedFilename?: string,
  options: CreateStorageKeyOptions = {},
): string => {
  const safeFolder = sanitizeFolder(folder);
  const sourceName = sanitizeFilename(requestedFilename || originalName);
  const extension = path.extname(sourceName).toLowerCase();
  const stem = path.basename(sourceName, extension);
  const id = randomUUID().replace(/-/g, '').slice(0, 12);

  const uniqueName = options.seoFriendly
    ? `${stem}-${id}${extension}`
    : `${Date.now()}-${id}-${stem}${extension}`;

  return `${safeFolder}/${uniqueName}`;
};

export const encodeStorageKey = (storageKey: string): string =>
  trimSlashes(storageKey)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

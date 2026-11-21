import { randomUUID } from 'node:crypto';
import { Schema } from 'mongoose';
import { logger } from '../../config/logger.js';
import { deleteAsset, prepareUpload, type StoredAsset } from '../file-manager/index.js';
import { AssetModel } from './asset.model.js';
import {
  buildFileFields,
  extractImageDimensions,
  getBaseName,
  resolveAssetType,
  resolveSlug,
} from './asset.utils.js';
import { storageService } from './storage/storage.service.js';
import type { StoredFile } from './storage/storage.types.js';

/**
 * Media embedded in content documents (blog banners, resources, ...).
 *
 * Every upload goes through the media-library storage service and is also
 * registered as an Asset, so content media shows up in the media library.
 */

export interface UploadedFile {
  provider?: string;
  url: string;
  storageKey: string;
  mimeType: string;
  originalName: string;
  /** SEO / accessibility metadata. */
  title?: string;
  description?: string;
  altText?: string;
  caption?: string;
  size: number;
  extension: string;
  uploadedAt: Date;
  etag?: string;
  width?: number;
  height?: number;
  duration?: number;
  pages?: number;
}

export interface FileMetadataInput {
  /** Identifies an existing file when editing retained media. */
  storageKey?: string;
  title?: string;
  description?: string;
  altText?: string;
  caption?: string;
}

type FileMetadata = Required<Pick<UploadedFile, 'title' | 'description' | 'altText' | 'caption'>>;

/** Reusable embedded schema for UploadedFile. */
export const uploadedFileSchema = new Schema<UploadedFile>(
  {
    provider: { type: String, trim: true },
    url: { type: String, required: true, trim: true },
    storageKey: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    originalName: { type: String, required: true, trim: true },
    title: { type: String, default: '', trim: true, maxlength: 200 },
    description: { type: String, default: '', trim: true, maxlength: 1000 },
    altText: { type: String, default: '', trim: true, maxlength: 300 },
    caption: { type: String, default: '', trim: true, maxlength: 500 },
    size: { type: Number, required: true, min: 0 },
    extension: { type: String, required: true, trim: true, lowercase: true },
    uploadedAt: { type: Date, required: true, default: Date.now },
    etag: { type: String, trim: true },
    width: { type: Number, min: 0 },
    height: { type: Number, min: 0 },
    duration: { type: Number, min: 0 },
    pages: { type: Number, min: 0 },
  },
  { _id: false, minimize: false },
);

const clean = (value: string | undefined): string => value?.trim() ?? '';

const toMetadata = (input: FileMetadataInput = {}): FileMetadata => ({
  title: clean(input.title),
  description: clean(input.description),
  altText: clean(input.altText),
  caption: clean(input.caption),
});

/** "blogs/banners" -> module "blogs", entity "banners". */
const toStoragePath = (folder: string) => {
  const [module = 'uploads', entity, ...rest] = folder.split('/').filter(Boolean);
  return { module, entity, category: rest.length ? rest.join('-') : undefined };
};

const toUploadedFile = (
  stored: StoredFile,
  sourceOriginalName: string,
  metadata: FileMetadata,
  dimensions: { width: number; height: number } | null,
): UploadedFile => ({
  provider: stored.provider,
  url: stored.url,
  storageKey: stored.key,
  mimeType: stored.mimeType,
  originalName: sourceOriginalName,
  ...metadata,
  size: stored.size,
  extension: (stored.extension ?? '').replace(/^\./, ''),
  uploadedAt: new Date(stored.uploadedAt),
  ...(stored.etag ? { etag: stored.etag } : {}),
  ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
});

export async function uploadMediaFile(
  file: Express.Multer.File,
  folder: string,
  input: FileMetadataInput = {},
): Promise<UploadedFile> {
  const metadata = toMetadata(input);
  const filename = metadata.title || metadata.altText || file.originalname;

  // Images are resized and converted to WebP before they reach storage.
  const prepared = await prepareUpload(file, filename);
  const upload = { ...file, ...prepared.file } as Express.Multer.File;

  const slug = resolveSlug(`${getBaseName(filename)}-${randomUUID().slice(0, 8)}`);
  const stored = await storageService.uploadFile({
    file: upload,
    seoName: slug,
    path: toStoragePath(folder),
  });

  const dimensions = await extractImageDimensions(upload.buffer, stored.mimeType);

  try {
    await AssetModel.create({
      ...buildFileFields(stored, slug, resolveAssetType(stored.mimeType), dimensions),
      slug,
      alt: metadata.altText || metadata.title || getBaseName(filename),
      title: metadata.title || getBaseName(filename),
      caption: metadata.caption,
      description: metadata.description,
    });
  } catch (error) {
    await storageService.deleteFile(stored.key, stored.provider).catch(() => undefined);
    throw error;
  }

  return toUploadedFile(stored, file.originalname, metadata, dimensions);
}

/** Uploads sequentially; rolls back already-uploaded files if one fails. */
export async function uploadMediaFiles(
  files: Express.Multer.File[],
  folder: string,
  inputs: FileMetadataInput[] = [],
): Promise<UploadedFile[]> {
  const uploaded: UploadedFile[] = [];
  try {
    for (const [index, file] of files.entries()) {
      uploaded.push(await uploadMediaFile(file, folder, inputs[index]));
    }
    return uploaded;
  } catch (error) {
    await Promise.allSettled(uploaded.map((file) => deleteMediaFile(file.storageKey)));
    throw error;
  }
}

/** Applies SEO metadata edits to an existing file; the stored object is unchanged. */
export function updateMediaMetadata(
  existing: UploadedFile,
  input: FileMetadataInput = {},
): UploadedFile {
  const pick = (key: keyof FileMetadata) =>
    Object.prototype.hasOwnProperty.call(input, key) ? clean(input[key]) : clean(existing[key]);
  return {
    ...existing,
    title: pick('title'),
    description: pick('description'),
    altText: pick('altText'),
    caption: pick('caption'),
  };
}

/** Deletes a stored object and its media-library record. Missing objects are a no-op. */
export async function deleteMediaFile(storageKey: string): Promise<void> {
  if (!storageKey) return;

  const libraryAsset = await AssetModel.findOne({ key: storageKey }).select('_id provider').lean();
  if (libraryAsset) {
    await storageService.deleteFile(storageKey, libraryAsset.provider);
    await AssetModel.deleteOne({ _id: libraryAsset._id });
    return;
  }

  const reference: StoredAsset = {
    provider: 's3',
    storageKey,
    originalName: storageKey.split('/').pop() || 'file',
    mimeType: 'application/octet-stream',
    size: 1,
    extension: storageKey.split('.').pop()?.toLowerCase() || '',
    visibility: 'public',
    uploadedAt: new Date(),
  };
  await deleteAsset(reference);
}

/** Best-effort cleanup that never throws (used after the database is already updated). */
export async function deleteMediaFilesQuietly(
  storageKeys: string[],
  context: string,
): Promise<void> {
  const keys = [...new Set(storageKeys.filter(Boolean))];
  const results = await Promise.allSettled(keys.map((key) => deleteMediaFile(key)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.error(
        { err: result.reason, storageKey: keys[index], context },
        'Stored file could not be deleted',
      );
    }
  });
}

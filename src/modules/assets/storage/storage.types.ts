import type { STORAGE_PROVIDERS } from './storage.constants.js';

export type StorageProviderName = (typeof STORAGE_PROVIDERS)[number];

export interface S3ProviderConfig {
  region: string;
  bucket: string;
  /** CDN / bucket base URL without a trailing slash. */
  publicUrl: string;
}

export interface StoragePath {
  /**
   * Main business area.
   *
   * Examples:
   * blogs
   * courses
   * users
   * programs
   * lessons
   */
  module: string;

  /**
   * Entity slug or ID.
   *
   * Examples:
   * rbi-grade-b
   * course-123
   * 68f123abc
   */
  entity?: string;

  /**
   * Logical asset category.
   *
   * Examples:
   * images
   * videos
   * documents
   * thumbnails
   */
  category?: string;
}

export interface UploadFileInput {
  file: Express.Multer.File;

  /**
   * SEO-readable filename.
   *
   * Example:
   * RBI Grade B Syllabus 2026
   */
  seoName: string;

  path: StoragePath;

  /**
   * default = inline
   */
  disposition?: 'inline' | 'attachment';

  cacheControl?: string;
}

export interface UploadMultipleFilesInput {
  files: Express.Multer.File[];

  path: StoragePath;

  /**
   * Can use one base name:
   * "RBI Grade B Notes"
   *
   * OR generate individual SEO names.
   */
  seoName: string | ((file: Express.Multer.File, index: number) => string);

  disposition?: 'inline' | 'attachment';

  cacheControl?: string;
}

export interface StoredFile {
  /** Provider that holds the object; required to delete it later. */
  provider: StorageProviderName;

  key: string;

  url: string;

  fileName: string;

  originalName: string;

  mimeType: string;

  extension: string | null;

  size: number;

  sizeFormatted: string;

  folder: string;

  etag?: string;

  uploadedAt: string;
}

export interface DeleteFileResult {
  key: string;
  deleted: boolean;
}

export interface DeleteMultipleResult {
  deleted: string[];
  failed: Array<{
    key: string;
    code?: string;
    message?: string;
  }>;
}

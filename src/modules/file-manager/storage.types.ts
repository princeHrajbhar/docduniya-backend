export type StorageProviderName = 's3';
export type AssetVisibility = 'public' | 'private';

/**
 * Framework-neutral file shape. Express.Multer.File is structurally compatible.
 */
export interface UploadableFile {
  /** In-memory uploads use `buffer`; large disk-backed uploads use `path`. */
  buffer?: Buffer;
  path?: string;
  originalname: string;
  mimetype: string;
  size: number;
  encoding?: string;
  fieldname?: string;
}

/**
 * Images are optimized before provider upload by default.
 *
 * Set `imageOptimization: false` on an upload only when the original image
 * bytes and format must be preserved.
 */
export interface ImageOptimizationOptions {
  /** WebP quality from 1 to 100. Default: 82. */
  quality?: number;
  /** Maximum output width. Default: 1920. */
  maxWidth?: number;
  /** Maximum output height. Default: 1920. */
  maxHeight?: number;
  /** WebP encoder effort from 0 to 6. Default: 4. */
  effort?: number;
  /** Preserve animation for animated GIF/WebP inputs. Default: true. */
  animated?: boolean;
}

/**
 * Store this object in MongoDB instead of storing only a URL.
 * `provider + storageKey` is the permanent identity; `url` is only a snapshot.
 */
export interface StoredAsset {
  provider: StorageProviderName;
  storageKey: string;

  /** Provider-ready filename. Converted images end in `.webp`. */
  originalName: string;
  /** Original client filename before image optimization. */
  sourceOriginalName?: string;

  mimeType: string;
  size: number;
  extension: string;
  visibility: AssetVisibility;
  uploadedAt: Date;

  /** SEO and accessibility metadata integrated with every managed asset. */
  title?: string;
  description?: string;
  altText?: string;
  caption?: string;

  /** Present for optimized images. Useful for width/height HTML attributes. */
  width?: number;
  height?: number;

  url?: string;
  etag?: string;
  version?: string | number;
  resourceType?: string;
  /** Provider delivery mode . */
  deliveryType?: string;
  checksum?: string;
  metadata?: Record<string, string>;
}

export interface UploadAssetInput {
  file: UploadableFile;
  folder: string;
  provider?: StorageProviderName;
  visibility?: AssetVisibility;

  /**
   * Human-readable filename or SEO phrase.
   *
   * For images, the extension is replaced with `.webp` automatically.
   * Example: `black-running-shoes`.
   */
  filename?: string;

  /**
   * Images are converted to WebP by default.
   * Pass `false` only when conversion must be disabled.
   */
  imageOptimization?: false | ImageOptimizationOptions;

  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  tags?: string[];
}

export interface UploadAssetsInput {
  files: UploadableFile[];
  folder: string;
  provider?: StorageProviderName;
  visibility?: AssetVisibility;
  imageOptimization?: false | ImageOptimizationOptions;
  cacheControl?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  /** Number of simultaneous provider uploads. */
  concurrency?: number;
  /** Remove already-uploaded files if any upload fails. Defaults to true. */
  rollbackOnFailure?: boolean;
}

export interface GetAssetUrlOptions {
  expiresInSeconds?: number;
  download?: boolean;
  filename?: string;
}

export interface ProviderUploadInput {
  file: UploadableFile;
  storageKey: string;
  visibility: AssetVisibility;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  tags?: string[];
}

export interface ProviderUploadResult {
  storageKey: string;
  url?: string;
  etag?: string;
  version?: string | number;
  resourceType?: string;
  /** Provider delivery mode . */
  deliveryType?: string;
  checksum?: string;
}

export interface ProviderAssetReference {
  storageKey: string;
  visibility: AssetVisibility;
  url?: string;
  version?: string | number;
  resourceType?: string;
  deliveryType?: string;
  mimeType?: string;
  originalName?: string;
}

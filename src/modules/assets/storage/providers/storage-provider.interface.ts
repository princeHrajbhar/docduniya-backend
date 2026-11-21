import type { DeleteMultipleResult, StorageProviderName } from '../storage.types.js';

export interface ProviderUploadInput {
  /** Provider-neutral object key, e.g. "blogs/rbi/images/slug--uuid.webp". */
  key: string;

  /** File contents. Held in memory; nothing is written to local disk. */
  body: Buffer;

  fileName: string;
  contentType: string;
  disposition: 'inline' | 'attachment';
  cacheControl: string;
}

export interface ProviderUploadResult {
  /**
   * Identifier to use for every later delete / URL lookup. The
   * provider returns the requested key unchanged.
   */
  key: string;

  /** Public URL the object is served from. */
  url: string;

  etag?: string;
}

/**
 * Port every storage backend implements. Implementations must:
 *  - throw AssetStorageError (never raw SDK errors),
 *  - treat deleting a missing object as success (idempotent).
 */
export interface StorageProvider {
  readonly name: StorageProviderName;

  upload(input: ProviderUploadInput): Promise<ProviderUploadResult>;

  delete(key: string): Promise<void>;

  /** Never throws for per-key failures; reports them in `failed`. */
  deleteMany(keys: string[]): Promise<DeleteMultipleResult>;

  getPublicUrl(key: string): string;
}

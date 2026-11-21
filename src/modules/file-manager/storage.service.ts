import { createHash } from 'node:crypto';
import fs from 'node:fs';

import type { StorageProviderRegistry } from './storage.registry.js';
import { StorageError } from './storage.errors.js';
import { prepareUpload } from './image.optimizer.js';
import { createStorageKey, getExtension } from './storage.key.js';
import type {
  GetAssetUrlOptions,
  ProviderAssetReference,
  StoredAsset,
  StorageProviderName,
  UploadAssetInput,
  UploadAssetsInput,
  UploadableFile,
} from './storage.types.js';

interface FileStorageServiceOptions {
  defaultProvider: StorageProviderName;
  defaultVisibility?: 'public' | 'private';
  uploadConcurrency?: number;
}

const assertUploadableFile = (file: UploadableFile): void => {
  const hasBuffer = Buffer.isBuffer(file?.buffer) && file.buffer.length > 0;
  const hasPath = typeof file?.path === 'string' && file.path.trim().length > 0;
  if (!file || (!hasBuffer && !hasPath)) {
    throw new StorageError(
      'A non-empty file buffer or temporary file path is required',
      'INVALID_UPLOAD_FILE',
    );
  }

  if (!file.originalname?.trim() || !file.mimetype?.trim() || file.size < 1) {
    throw new StorageError('Invalid upload file metadata', 'INVALID_UPLOAD_FILE');
  }
};

const checksumUpload = async (file: UploadableFile): Promise<string> => {
  if (Buffer.isBuffer(file.buffer)) {
    return createHash('sha256').update(file.buffer).digest('hex');
  }
  if (!file.path) throw new StorageError('Upload source is unavailable', 'INVALID_UPLOAD_FILE');
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file.path!);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return hash.digest('hex');
};

const toProviderReference = (asset: StoredAsset): ProviderAssetReference => ({
  storageKey: asset.storageKey,
  visibility: asset.visibility === 'private' ? 'private' : 'public',
  url: asset.url,
  version: asset.version,
  resourceType: asset.resourceType,
  deliveryType: asset.deliveryType,
  mimeType: asset.mimeType,
  originalName: asset.originalName,
});

const removeDuplicateTerminalExtension = (value: string): string =>
  value.replace(/(\.[a-z0-9]{2,10})\1(?=([?#]|$))/i, '$1');

const normalizeAssetUrl = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (!url) return '';

  // Provider URLs may be absolute or application-relative. Reject dangerous
  // schemes so legacy metadata cannot become a javascript: link in clients.
  if (url.startsWith('/')) return removeDuplicateTerminalExtension(url);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.pathname = removeDuplicateTerminalExtension(parsed.pathname);
    return parsed.toString();
  } catch {
    return '';
  }
};

export class FileStorageService {
  private readonly defaultVisibility: 'public' | 'private';
  private readonly uploadConcurrency: number;

  constructor(
    private readonly registry: StorageProviderRegistry,
    private readonly options: FileStorageServiceOptions,
  ) {
    this.defaultVisibility = options.defaultVisibility || 'public';
    this.uploadConcurrency = Math.max(1, options.uploadConcurrency || 4);
  }

  async upload(input: UploadAssetInput): Promise<StoredAsset> {
    assertUploadableFile(input.file);

    const prepared = await prepareUpload(input.file, input.filename, input.imageOptimization);

    const providerName = input.provider || this.options.defaultProvider;
    const provider = this.registry.get(providerName);
    const visibility = input.visibility || this.defaultVisibility;
    const storageKey = createStorageKey(
      input.folder,
      prepared.file.originalname,
      prepared.requestedFilename,
      { seoFriendly: true },
    );

    /*
     * Unique object keys make long-lived caching safe for public optimized
     * images. Caller-provided Cache-Control always takes precedence.
     */
    const cacheControl =
      input.cacheControl ||
      (prepared.optimizedImage && visibility === 'public'
        ? 'public, max-age=31536000, immutable'
        : undefined);

    const result = await provider.upload({
      file: prepared.file,
      storageKey,
      visibility,
      cacheControl,
      contentDisposition: input.contentDisposition,
      metadata: input.metadata,
      tags: input.tags,
    });

    return {
      provider: providerName,
      storageKey: result.storageKey,
      originalName: prepared.file.originalname,
      ...(prepared.sourceOriginalName ? { sourceOriginalName: prepared.sourceOriginalName } : {}),
      mimeType: prepared.file.mimetype,
      size: prepared.file.size,
      extension: getExtension(prepared.file.originalname),
      visibility,
      uploadedAt: new Date(),
      title: input.metadata?.title || '',
      description: input.metadata?.description || '',
      altText: input.metadata?.altText || input.metadata?.['alt-text'] || '',
      caption: input.metadata?.caption || '',
      ...(prepared.width ? { width: prepared.width } : {}),
      ...(prepared.height ? { height: prepared.height } : {}),
      checksum: result.checksum || (await checksumUpload(prepared.file)),
      ...(result.url ? { url: result.url } : {}),
      ...(result.etag ? { etag: result.etag } : {}),
      ...(result.version !== undefined ? { version: result.version } : {}),
      ...(result.resourceType ? { resourceType: result.resourceType } : {}),
      ...(result.deliveryType ? { deliveryType: result.deliveryType } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  }

  async uploadMany(input: UploadAssetsInput): Promise<StoredAsset[]> {
    if (!input.files.length) return [];

    const concurrency = Math.max(
      1,
      Math.min(input.concurrency || this.uploadConcurrency, input.files.length),
    );
    const uploaded: StoredAsset[] = [];
    let cursor = 0;
    let failure: unknown;

    const worker = async (): Promise<void> => {
      while (!failure) {
        const index = cursor++;
        const file = input.files[index];
        if (!file) return;

        try {
          const asset = await this.upload({
            file,
            folder: input.folder,
            provider: input.provider,
            visibility: input.visibility,
            imageOptimization: input.imageOptimization,
            cacheControl: input.cacheControl,
            metadata: input.metadata,
            tags: input.tags,
          });
          uploaded[index] = asset;
        } catch (error) {
          failure = error;
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (failure) {
      if (input.rollbackOnFailure !== false) {
        await Promise.allSettled(uploaded.filter(Boolean).map((asset) => this.delete(asset)));
      }
      throw failure;
    }

    return uploaded;
  }

  async delete(asset?: StoredAsset | null): Promise<void> {
    if (!asset || !asset.storageKey) return;
    const providerName = this.resolveProviderName(asset);

    // Legacy URL-only assets cannot be safely deleted from a provider. The
    // owning database record can still be removed without failing the request.
    if (!providerName) return;

    const provider = this.registry.get(providerName);
    await provider.delete(toProviderReference(asset));
  }

  async deleteMany(assets: Array<StoredAsset | null | undefined>): Promise<void> {
    const results = await Promise.allSettled(
      assets
        .filter((asset): asset is StoredAsset => Boolean(asset))
        .map((asset) => this.delete(asset)),
    );

    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      throw new StorageError(
        `${failures.length} asset deletion(s) failed`,
        'DELETE_FAILED',
        failures,
      );
    }
  }

  async getUrl(asset?: StoredAsset | null, options: GetAssetUrlOptions = {}): Promise<string> {
    if (!asset) return '';

    const directUrl = normalizeAssetUrl(asset.url);
    const providerName = this.resolveProviderName(asset);

    // Existing databases may contain files created before provider metadata
    // was introduced. Preserve those records by serving their stored URL.
    if (!providerName) return directUrl;
    if (!asset.storageKey) return directUrl;

    const provider = this.registry.get(providerName);
    const reference = toProviderReference(asset);
    const visibility = asset.visibility === 'private' ? 'private' : 'public';

    if (visibility === 'public' && !options.download) {
      const publicUrl = provider.getPublicUrl(reference) || directUrl;
      if (publicUrl) return publicUrl;

      // Private S3-compatible deployments (for example MinIO) may not expose
      // a public bucket URL. A short-lived signed URL keeps the object private
      // while still allowing the profile image to render in the client.
      if (provider.getSignedUrl) {
        return provider.getSignedUrl(reference, options);
      }
    }

    if (provider.getSignedUrl) {
      return provider.getSignedUrl(reference, options);
    }

    // A direct provider URL is still useful for legacy records even when the
    // configured adapter cannot produce signed links.
    return directUrl;
  }

  async exists(asset: StoredAsset): Promise<boolean> {
    const providerName = this.resolveProviderName(asset);
    if (!providerName || !asset.storageKey) return Boolean(normalizeAssetUrl(asset.url));
    const provider = this.registry.get(providerName);
    return provider.exists ? provider.exists(toProviderReference(asset)) : true;
  }

  private resolveProviderName(asset: StoredAsset): StorageProviderName | undefined {
    const rawStoredProvider = typeof asset.provider === 'string' ? asset.provider.trim() : '';
    const storedProvider = ['undefined', 'null', 'unknown'].includes(
      rawStoredProvider.toLowerCase(),
    )
      ? ''
      : rawStoredProvider;

    if (storedProvider) {
      return storedProvider === 's3' && this.registry.has('s3') ? 's3' : undefined;
    }

    const url = normalizeAssetUrl(asset.url).toLowerCase();
    if ((url.includes('amazonaws.com') || url.includes('.s3.')) && this.registry.has('s3')) {
      return 's3';
    }

    // Records written during the provider migration sometimes have a key but
    // no provider. In that case the configured default is the only reliable
    // adapter and is safe to use.
    if (asset.storageKey && !url && this.registry.has(this.options.defaultProvider)) {
      return this.options.defaultProvider;
    }

    return undefined;
  }
}

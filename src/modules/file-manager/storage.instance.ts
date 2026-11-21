import { presentAssetUrls } from './asset.presenter.js';
import { S3StorageProvider } from './providers/s3.provider.js';
import { loadFileStorageConfig } from './storage.config.js';
import { StorageError } from './storage.errors.js';
import { StorageProviderRegistry } from './storage.registry.js';
import { FileStorageService } from './storage.service.js';
import type {
  GetAssetUrlOptions,
  StoredAsset,
  UploadAssetInput,
  UploadAssetsInput,
} from './storage.types.js';

let instance: { service: FileStorageService; registry: StorageProviderRegistry } | undefined;

/**
 * Built on first use so the API (and tests) can start without storage
 * credentials; a misconfiguration surfaces on the first file operation.
 */
function getInstance() {
  if (instance) return instance;

  const config = loadFileStorageConfig();
  const registry = new StorageProviderRegistry();
  registry.register(new S3StorageProvider(config.s3));

  if (!registry.has(config.defaultProvider)) {
    throw new StorageError(
      `Default storage provider "${config.defaultProvider}" is not configured. Configured providers: ${registry.names().join(', ') || 'none'}`,
      'STORAGE_PROVIDER_NOT_CONFIGURED',
    );
  }

  instance = {
    registry,
    service: new FileStorageService(registry, {
      defaultProvider: config.defaultProvider,
      defaultVisibility: config.defaultVisibility,
      uploadConcurrency: config.uploadConcurrency,
    }),
  };
  return instance;
}

export const getFileStorage = (): FileStorageService => getInstance().service;
export const getConfiguredStorageProviders = () => getInstance().registry.names();

export const uploadAsset = (input: UploadAssetInput): Promise<StoredAsset> =>
  getFileStorage().upload(input);
export const uploadAssets = (input: UploadAssetsInput): Promise<StoredAsset[]> =>
  getFileStorage().uploadMany(input);
export const deleteAsset = (asset?: StoredAsset | null): Promise<void> =>
  getFileStorage().delete(asset);
export const deleteAssets = (assets: Array<StoredAsset | null | undefined>): Promise<void> =>
  getFileStorage().deleteMany(assets);
export const getAssetUrl = (
  asset?: StoredAsset | null,
  options?: GetAssetUrlOptions,
): Promise<string> => getFileStorage().getUrl(asset, options);
export const presentAssets = <T>(payload: T, options?: GetAssetUrlOptions): Promise<T> =>
  presentAssetUrls(payload, getFileStorage(), options);

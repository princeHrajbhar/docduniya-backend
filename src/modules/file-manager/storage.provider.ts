import type {
  GetAssetUrlOptions,
  ProviderAssetReference,
  ProviderUploadInput,
  ProviderUploadResult,
  StorageProviderName,
} from './storage.types.js';

export interface StorageProvider {
  readonly name: StorageProviderName;

  upload(input: ProviderUploadInput): Promise<ProviderUploadResult>;
  delete(asset: ProviderAssetReference): Promise<void>;
  download(asset: ProviderAssetReference): Promise<Buffer>;
  exists?(asset: ProviderAssetReference): Promise<boolean>;
  getPublicUrl(asset: ProviderAssetReference): string | undefined;
  getSignedUrl?(asset: ProviderAssetReference, options?: GetAssetUrlOptions): Promise<string>;
}

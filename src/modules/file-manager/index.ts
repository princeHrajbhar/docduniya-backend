/**
 * Provider-agnostic file storage. Application code calls `uploadAsset(...)`,
 * persists the returned `StoredAsset` (provider + storageKey) and resolves
 * URLs at response time with `getAssetUrl(...)`. Nothing outside this module
 * imports the AWS SDK.
 */
export * from './storage.types.js';
export * from './storage.errors.js';
export * from './storage.provider.js';
export * from './storage.registry.js';
export * from './storage.service.js';
export * from './storage.key.js';
export * from './image.optimizer.js';
export * from './asset.schema.js';
export * from './asset.presenter.js';
export * from './upload.middleware.js';
export * from './storage.instance.js';
export * from './providers/s3.provider.js';

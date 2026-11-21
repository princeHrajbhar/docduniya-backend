import { STORAGE_ERROR_CODES, STORAGE_PROVIDERS } from './storage.constants.js';
import { AssetStorageError } from './storage.error.js';
import { S3StorageProvider } from './providers/s3.provider.js';
import type { StorageProvider } from './providers/storage-provider.interface.js';
import type { StorageProviderName } from './storage.types.js';

/** The active provider for new uploads. Only S3 is registered. */
const ACTIVE_PROVIDER: StorageProviderName = 's3';

const optional = (value: string | undefined): string | undefined => value?.trim() || undefined;

function requireConfig(value: string | undefined, name: string): string {
  if (!value) {
    throw new AssetStorageError(
      `Missing configuration: ${name}`,
      STORAGE_ERROR_CODES.PROVIDER_CONFIG,
      500,
    );
  }
  return value;
}

/**
 * The only place that knows which concrete providers exist and how they are
 * configured. The rest of the codebase sees only the StorageProvider interface.
 */
const factories: Record<StorageProviderName, () => StorageProvider> = {
  s3: () => {
    const region = requireConfig(optional(process.env.AWS_REGION), 'AWS_REGION');
    const bucket = requireConfig(
      optional(process.env.AWS_S3_BUCKET) ?? optional(process.env.AWS_BUCKET_NAME),
      'AWS_S3_BUCKET',
    );
    const publicUrl =
      optional(process.env.AWS_CDN_URL) ??
      optional(process.env.ASSET_BASE_URL) ??
      `https://${bucket}.s3.${region}.amazonaws.com`;

    return new S3StorageProvider({ region, bucket, publicUrl: publicUrl.replace(/\/+$/, '') });
  },
};

// Providers are built lazily, so only the ones actually used need configuration,
// and old assets keep resolving their original provider.
const instances = new Map<StorageProviderName, StorageProvider>();

function isProviderName(value: string): value is StorageProviderName {
  return (STORAGE_PROVIDERS as readonly string[]).includes(value);
}

export function getStorageProvider(name?: string): StorageProvider {
  const providerName = name ?? ACTIVE_PROVIDER;

  if (!isProviderName(providerName)) {
    throw new AssetStorageError(
      `Unknown storage provider: ${providerName}`,
      STORAGE_ERROR_CODES.UNKNOWN_PROVIDER,
      500,
    );
  }

  let provider = instances.get(providerName);
  if (!provider) {
    provider = factories[providerName]();
    instances.set(providerName, provider);
  }
  return provider;
}

export function getActiveStorageProvider(): StorageProvider {
  return getStorageProvider(ACTIVE_PROVIDER);
}

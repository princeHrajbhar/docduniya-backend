import type { StorageProviderName } from './storage.types.js';

export interface S3StorageConfig {
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
  publicEndpoint?: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
}

export interface FileStorageConfig {
  defaultProvider: StorageProviderName;
  defaultVisibility: 'public' | 'private';
  uploadConcurrency: number;
  s3: S3StorageConfig;
}

const optional = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized || undefined;
};

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * S3 is the only storage provider. A missing bucket or region is a startup
 * error rather than a silent fallback to another store.
 */
export const loadFileStorageConfig = (env: NodeJS.ProcessEnv = process.env): FileStorageConfig => {
  const defaultVisibility = env.STORAGE_DEFAULT_VISIBILITY === 'private' ? 'private' : 'public';

  const region = optional(env.AWS_REGION);
  const bucket = optional(env.AWS_BUCKET_NAME) || optional(env.AWS_S3_BUCKET);

  if (!region || !bucket) {
    throw new Error('S3 storage is not configured: set AWS_REGION and AWS_BUCKET_NAME');
  }

  return {
    defaultProvider: 's3',
    defaultVisibility,
    uploadConcurrency: positiveInteger(env.STORAGE_UPLOAD_CONCURRENCY, 4),
    s3: {
      region,
      bucket,
      accessKeyId: optional(env.AWS_ACCESS_KEY_ID),
      secretAccessKey: optional(env.AWS_SECRET_ACCESS_KEY),
      endpoint: optional(env.AWS_S3_ENDPOINT),
      publicEndpoint: optional(env.AWS_S3_PUBLIC_ENDPOINT),
      forcePathStyle: env.AWS_FORCE_PATH_STYLE === 'true' || bucket.includes('.'),
      publicBaseUrl: optional(env.ASSET_BASE_URL),
    },
  };
};

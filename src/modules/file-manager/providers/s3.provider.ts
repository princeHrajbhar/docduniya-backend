import fs from 'node:fs';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { S3StorageConfig } from '../storage.config.js';
import { StorageError } from '../storage.errors.js';
import { encodeStorageKey } from '../storage.key.js';
import type { StorageProvider } from '../storage.provider.js';
import type {
  GetAssetUrlOptions,
  ProviderAssetReference,
  ProviderUploadInput,
  ProviderUploadResult,
} from '../storage.types.js';

const streamToBuffer = async (body: unknown): Promise<Buffer> => {
  if (!body) return Buffer.alloc(0);
  if (body instanceof Uint8Array) return Buffer.from(body);

  const transform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof transform.transformToByteArray === 'function') {
    return Buffer.from(await transform.transformToByteArray());
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;
  private readonly client: S3Client;
  private readonly signingClient: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    const credentials =
      config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {};

    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      ...credentials,
    });
    this.signingClient = config.publicEndpoint
      ? new S3Client({
          region: config.region,
          endpoint: config.publicEndpoint,
          forcePathStyle: config.forcePathStyle,
          ...credentials,
        })
      : this.client;
  }

  async upload(input: ProviderUploadInput): Promise<ProviderUploadResult> {
    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.config.bucket,
          Key: input.storageKey,
          Body: Buffer.isBuffer(input.file.buffer)
            ? input.file.buffer
            : input.file.path
              ? fs.createReadStream(input.file.path)
              : undefined,
          ContentType: input.file.mimetype,
          CacheControl: input.cacheControl,
          ContentDisposition: input.contentDisposition,
          Metadata: input.metadata,
        },
      });

      const result = await upload.done();
      return {
        storageKey: input.storageKey,
        url: this.getPublicUrl({
          storageKey: input.storageKey,
          visibility: input.visibility,
        }),
        ...(result.ETag ? { etag: result.ETag.replace(/"/g, '') } : {}),
      };
    } catch (error) {
      throw new StorageError('S3 upload failed', 'UPLOAD_FAILED', error);
    }
  }

  async delete(asset: ProviderAssetReference): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: asset.storageKey,
        }),
      );
    } catch (error) {
      throw new StorageError('S3 delete failed', 'DELETE_FAILED', error);
    }
  }

  async download(asset: ProviderAssetReference): Promise<Buffer> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: asset.storageKey,
        }),
      );
      return streamToBuffer(result.Body);
    } catch (error) {
      throw new StorageError('S3 download failed', 'DOWNLOAD_FAILED', error);
    }
  }

  async exists(asset: ProviderAssetReference): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: asset.storageKey,
        }),
      );
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 404) return false;
      throw error;
    }
  }

  getPublicUrl(asset: ProviderAssetReference): string | undefined {
    if (asset.visibility !== 'public') return undefined;

    if (this.config.publicBaseUrl) {
      return `${this.config.publicBaseUrl.replace(/\/$/, '')}/${encodeStorageKey(asset.storageKey)}`;
    }

    if (this.config.endpoint) return undefined;

    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${encodeStorageKey(asset.storageKey)}`;
  }

  async getSignedUrl(
    asset: ProviderAssetReference,
    options: GetAssetUrlOptions = {},
  ): Promise<string> {
    const responseContentDisposition = options.download
      ? `attachment; filename="${options.filename || asset.originalName || 'download'}"`
      : undefined;

    return getSignedUrl(
      this.signingClient,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: asset.storageKey,
        ResponseContentDisposition: responseContentDisposition,
      }),
      { expiresIn: options.expiresInSeconds || 900 },
    );
  }
}

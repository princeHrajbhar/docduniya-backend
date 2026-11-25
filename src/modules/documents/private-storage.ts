import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/api-error.js';

/**
 * Private object storage for clinical documents. It is deliberately separate from the public
 * media library: objects are never public, URLs are short-lived and version specific.
 */
export interface PrivateObjectStore {
  readonly provider: string;
  readonly bucket: string;
  presignUpload(
    key: string,
    mimeType: string,
    sizeBytes: number,
    expiresSeconds: number,
  ): Promise<string>;
  head(
    key: string,
  ): Promise<{ sizeBytes: number; contentType?: string; versionId?: string } | undefined>;
  read(key: string, maxBytes: number): Promise<Buffer>;
  /** Stores the exact scanned bytes once. Never copy a mutable upload key. */
  putImmutable(key: string, content: Buffer, mimeType: string): Promise<{ versionId?: string }>;
  remove(key: string): Promise<void>;
  presignDownload(
    key: string,
    options: { versionId?: string; filename: string; mimeType: string; expiresSeconds: number },
  ): Promise<string>;
}

class S3PrivateStore implements PrivateObjectStore {
  readonly provider = 's3';
  private readonly client: S3Client;
  constructor(readonly bucket: string) {
    this.client = new S3Client({
      region: env.PRIVATE_DOCUMENTS_REGION ?? process.env.AWS_REGION ?? 'ap-south-1',
      endpoint: process.env.AWS_S3_ENDPOINT || undefined,
      forcePathStyle: process.env.AWS_FORCE_PATH_STYLE === 'true',
    });
  }
  presignUpload(key: string, mimeType: string, sizeBytes: number, expiresSeconds: number) {
    // Content type and exact length are part of the signature; a different upload is refused.
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: mimeType,
        ContentLength: sizeBytes,
      }),
      { expiresIn: expiresSeconds },
    );
  }
  async head(key: string) {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: result.ContentLength ?? 0,
        contentType: result.ContentType,
        versionId: result.VersionId,
      };
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound') return undefined;
      throw error;
    }
  }
  async read(key: string, maxBytes: number) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if ((result.ContentLength ?? 0) > maxBytes)
      throw new Error('Object exceeds the permitted size');
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      length += chunk.length;
      if (length > maxBytes) throw new Error('Object exceeds the permitted size');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  async putImmutable(key: string, content: Buffer, mimeType: string) {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentLength: content.length,
        ContentType: mimeType,
        IfNoneMatch: '*',
      }),
    );
    return { versionId: result.VersionId };
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  presignDownload(
    key: string,
    options: { versionId?: string; filename: string; mimeType: string; expiresSeconds: number },
  ) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        VersionId: options.versionId,
        ResponseContentType: options.mimeType,
        ResponseContentDisposition: `attachment; filename="${options.filename}"`,
      }),
      { expiresIn: options.expiresSeconds },
    );
  }
}

let store: PrivateObjectStore | undefined;
export function privateStore(): PrivateObjectStore {
  if (!store) {
    if (!env.PRIVATE_DOCUMENTS_BUCKET)
      throw new ApiError(
        503,
        'Private document storage is not configured',
        undefined,
        'DOCUMENT_STORAGE_UNAVAILABLE',
      );
    if (env.PRIVATE_DOCUMENTS_BUCKET === process.env.AWS_S3_BUCKET)
      throw new ApiError(
        503,
        'Clinical documents must not share the public media bucket',
        undefined,
        'DOCUMENT_STORAGE_UNSAFE',
      );
    store = new S3PrivateStore(env.PRIVATE_DOCUMENTS_BUCKET);
  }
  return store;
}
/** Test and alternative-provider seam. */
export function setPrivateStore(next: PrivateObjectStore): void {
  store = next;
}

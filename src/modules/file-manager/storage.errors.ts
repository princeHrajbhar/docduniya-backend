export type StorageErrorCode =
  | 'STORAGE_PROVIDER_NOT_FOUND'
  | 'STORAGE_PROVIDER_NOT_CONFIGURED'
  | 'INVALID_UPLOAD_FILE'
  | 'INVALID_STORAGE_KEY'
  | 'IMAGE_OPTIMIZATION_FAILED'
  | 'UPLOAD_FAILED'
  | 'DELETE_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'SIGNED_URL_UNSUPPORTED';

const STATUS_BY_CODE: Record<StorageErrorCode, number> = {
  STORAGE_PROVIDER_NOT_FOUND: 500,
  STORAGE_PROVIDER_NOT_CONFIGURED: 500,
  INVALID_UPLOAD_FILE: 400,
  INVALID_STORAGE_KEY: 400,
  IMAGE_OPTIMIZATION_FAILED: 400,
  UPLOAD_FAILED: 502,
  DELETE_FAILED: 502,
  DOWNLOAD_FAILED: 404,
  SIGNED_URL_UNSUPPORTED: 500,
};

export class StorageError extends Error {
  public readonly statusCode: number;

  constructor(
    message: string,
    public readonly code: StorageErrorCode,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'StorageError';
    this.statusCode = STATUS_BY_CODE[code];
  }
}

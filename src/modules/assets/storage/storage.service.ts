import { logger } from '../../../config/logger.js';
import {
  DEFAULT_CACHE_CONTROL,
  DEFAULT_DISPOSITION,
  STORAGE_ERROR_CODES,
} from './storage.constants.js';
import { AssetStorageError } from './storage.error.js';
import { getActiveStorageProvider, getStorageProvider } from './storage.registry.js';
import {
  buildStorageFolder,
  createSeoFileName,
  formatBytes,
  getFileExtension,
} from './storage.utils.js';
import type {
  DeleteFileResult,
  DeleteMultipleResult,
  StoredFile,
  UploadFileInput,
  UploadMultipleFilesInput,
} from './storage.types.js';

/**
 * Provider-agnostic storage orchestration: validation, key naming and
 * rollback. All vendor specifics live behind the StorageProvider port.
 *
 * Files arrive as in-memory buffers; nothing touches the local disk.
 */
class StorageService {
  /** Uploads to the active provider. */
  async uploadFile(input: UploadFileInput): Promise<StoredFile> {
    const {
      file,
      seoName,
      path,
      disposition = DEFAULT_DISPOSITION,
      cacheControl = DEFAULT_CACHE_CONTROL,
    } = input;

    if (!file) {
      throw new AssetStorageError('File is required', STORAGE_ERROR_CODES.FILE_REQUIRED, 400);
    }

    if (!seoName?.trim()) {
      throw new AssetStorageError(
        'SEO filename is required',
        STORAGE_ERROR_CODES.SEO_NAME_REQUIRED,
        400,
      );
    }

    if (!file.buffer?.length) {
      throw new AssetStorageError(
        'Uploaded file is empty',
        STORAGE_ERROR_CODES.FILE_BODY_MISSING,
        400,
      );
    }

    const provider = getActiveStorageProvider();

    const folder = buildStorageFolder(path);
    const fileName = createSeoFileName(seoName, file.originalname);
    const mimeType = file.mimetype || 'application/octet-stream';

    const uploaded = await provider.upload({
      key: `${folder}/${fileName}`,
      body: file.buffer,
      fileName,
      contentType: mimeType,
      disposition,
      cacheControl,
    });

    return {
      provider: provider.name,
      key: uploaded.key,
      url: uploaded.url,
      fileName,
      originalName: file.originalname,
      mimeType,
      extension: getFileExtension(file.originalname),
      size: file.size,
      sizeFormatted: formatBytes(file.size),
      folder,
      etag: uploaded.etag,
      uploadedAt: new Date().toISOString(),
    };
  }

  /**
   * Sequential on purpose (avoids many large uploads competing for
   * bandwidth). If one fails, everything already uploaded is rolled back.
   */
  async uploadMultipleFiles(input: UploadMultipleFilesInput): Promise<StoredFile[]> {
    const { files, path, seoName, disposition, cacheControl } = input;

    if (!files || files.length === 0) {
      throw new AssetStorageError(
        'At least one file is required',
        STORAGE_ERROR_CODES.FILES_REQUIRED,
        400,
      );
    }

    const uploadedFiles: StoredFile[] = [];

    try {
      for (const [index, file] of files.entries()) {
        const generatedSeoName =
          typeof seoName === 'function' ? seoName(file, index) : `${seoName}-${index + 1}`;

        uploadedFiles.push(
          await this.uploadFile({
            file,
            path,
            seoName: generatedSeoName,
            disposition,
            cacheControl,
          }),
        );
      }

      return uploadedFiles;
    } catch (error) {
      await Promise.allSettled(
        uploadedFiles.map((stored) => this.deleteFile(stored.key, stored.provider)),
      );

      throw error;
    }
  }

  /**
   * Deletes from the provider that stored the object. Defaults to the
   * active provider when none is given.
   */
  async deleteFile(key: string, providerName?: string): Promise<DeleteFileResult> {
    if (!key?.trim()) {
      throw new AssetStorageError('Object key is required', STORAGE_ERROR_CODES.KEY_REQUIRED, 400);
    }

    await getStorageProvider(providerName).delete(key);

    return { key, deleted: true };
  }

  async deleteFiles(keys: string[], providerName?: string): Promise<DeleteMultipleResult> {
    const uniqueKeys = [...new Set(keys.filter(Boolean))];

    if (uniqueKeys.length === 0) {
      return { deleted: [], failed: [] };
    }

    return getStorageProvider(providerName).deleteMany(uniqueKeys);
  }

  /**
   * Uploads the new file first and removes the old object only afterwards,
   * so a failure never leaves the caller without a file.
   */
  async replaceFile(params: {
    oldKey: string;
    oldProvider?: string;
    newFile: UploadFileInput;
  }): Promise<StoredFile> {
    const { oldKey, oldProvider, newFile } = params;

    const uploaded = await this.uploadFile(newFile);

    try {
      await this.deleteFile(oldKey, oldProvider);

      return uploaded;
    } catch (error) {
      await this.deleteFile(uploaded.key, uploaded.provider).catch((rollbackError) =>
        logger.error({ err: rollbackError }, 'Replacement rollback failed'),
      );

      throw new AssetStorageError(
        'New file uploaded but existing file could not be replaced safely',
        'FILE_REPLACEMENT_FAILED',
        500,
        error,
      );
    }
  }

  getPublicUrl(key: string, providerName?: string): string {
    return getStorageProvider(providerName).getPublicUrl(key);
  }
}

export const storageService = new StorageService();

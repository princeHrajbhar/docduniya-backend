import multer from 'multer';
import { env } from '../../config/env.js';
import { AppError, ErrorCode } from '../../utils/app-error.js';

/**
 * Types that a browser would execute or render as active content when served
 * inline from the public CDN. They are never accepted into the media library.
 */
const BLOCKED_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/x-msdownload',
  'application/x-sh',
]);
const BLOCKED_EXTENSIONS = /\.(html?|xhtml|svg|js|mjs|exe|sh|bat|cmd|ps1)$/i;

/**
 * Uploads are held in memory and streamed to the storage provider; nothing is
 * written to the server's disk. Memory per request is bounded by
 * MAX_FILE_SIZE_MB x MAX_FILES_PER_REQUEST.
 */
export const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024,
    files: env.MAX_FILES_PER_REQUEST,
  },
  fileFilter: (_req, file, callback) => {
    if (
      BLOCKED_MIME_TYPES.has(file.mimetype.toLowerCase()) ||
      BLOCKED_EXTENSIONS.test(file.originalname)
    ) {
      callback(
        new AppError(
          `Unsupported file type "${file.originalname}"`,
          400,
          ErrorCode.VALIDATION_ERROR,
        ),
      );
      return;
    }
    callback(null, true);
  },
});

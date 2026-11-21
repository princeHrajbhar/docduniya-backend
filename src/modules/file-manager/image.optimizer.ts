import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { StorageError } from './storage.errors.js';
import { sanitizeFilename } from './storage.key.js';
import type { ImageOptimizationOptions, UploadableFile } from './storage.types.js';

const DEFAULT_QUALITY = 82;
const DEFAULT_MAX_WIDTH = 1920;
const DEFAULT_MAX_HEIGHT = 1920;
const DEFAULT_EFFORT = 4;
const MAX_INPUT_PIXELS = 100_000_000;

const clampInteger = (
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value as number)));
};

export const isImageUpload = (file: UploadableFile): boolean =>
  file.mimetype.toLowerCase().startsWith('image/');

const createWebpFilename = (originalName: string, requestedFilename?: string): string => {
  const source = sanitizeFilename(requestedFilename || originalName);
  const extension = path.extname(source);
  const stem = path.basename(source, extension) || 'image';

  return `${stem}.webp`;
};

export interface PreparedUpload {
  file: UploadableFile;
  requestedFilename?: string;
  optimizedImage: boolean;
  sourceOriginalName?: string;
  width?: number;
  height?: number;
}

/**
 * Converts supported images to WebP before any storage provider receives them.
 * Non-image files and explicitly disabled image optimization pass through.
 */
export const prepareUpload = async (
  file: UploadableFile,
  requestedFilename?: string,
  options: false | ImageOptimizationOptions | undefined = undefined,
): Promise<PreparedUpload> => {
  if (!isImageUpload(file) || options === false) {
    return {
      file,
      requestedFilename,
      optimizedImage: false,
    };
  }

  const settings = options || {};
  const quality = clampInteger(settings.quality, 1, 100, DEFAULT_QUALITY);
  const maxWidth = clampInteger(settings.maxWidth, 1, 10_000, DEFAULT_MAX_WIDTH);
  const maxHeight = clampInteger(settings.maxHeight, 1, 10_000, DEFAULT_MAX_HEIGHT);
  const effort = clampInteger(settings.effort, 0, 6, DEFAULT_EFFORT);
  const animated = settings.animated !== false;
  const webpFilename = createWebpFilename(file.originalname, requestedFilename);

  try {
    const imageInput = Buffer.isBuffer(file.buffer)
      ? file.buffer
      : file.path
        ? await fs.readFile(file.path)
        : undefined;
    if (!imageInput) throw new Error('Image bytes are unavailable');
    const pipeline = sharp(imageInput, {
      animated,
      failOn: 'warning',
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({
        width: maxWidth,
        height: maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality,
        effort,
      });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    if (!info.width || !info.height || data.length === 0) {
      throw new Error('Image processor returned invalid output');
    }

    return {
      file: {
        ...file,
        buffer: data,
        originalname: webpFilename,
        mimetype: 'image/webp',
        size: data.length,
      },
      requestedFilename: webpFilename,
      optimizedImage: true,
      sourceOriginalName: file.originalname,
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    throw new StorageError(
      'Image could not be decoded or converted to WebP',
      'IMAGE_OPTIMIZATION_FAILED',
      error,
    );
  }
};

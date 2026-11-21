import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import multer from 'multer';
import path from 'node:path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, ErrorCode } from '../../utils/app-error.js';

export interface UploadFieldPolicy {
  name: string;
  maxCount: number;
  mimeTypes: readonly string[];
  extensions?: readonly string[];
}

export interface UploadMiddlewarePolicy {
  fields: readonly UploadFieldPolicy[];
  maxFileSizeBytes?: number;
  maxFieldSizeBytes?: number;
  maxFiles?: number;
}

const normalizeExtension = (value: string): string =>
  value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`;

export const createUploadFields = (policy: UploadMiddlewarePolicy) => {
  const fieldRules = new Map(policy.fields.map((field) => [field.name, field]));

  const middleware = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: policy.maxFileSizeBytes || 25 * 1024 * 1024,
      fieldSize: policy.maxFieldSizeBytes || 1024 * 1024,
      files: policy.maxFiles || policy.fields.reduce((sum, field) => sum + field.maxCount, 0),
    },
    fileFilter: (_req, file, callback) => {
      const rule = fieldRules.get(file.fieldname);
      if (!rule) {
        callback(
          new AppError(
            `Unexpected upload field "${file.fieldname}"`,
            400,
            ErrorCode.VALIDATION_ERROR,
          ),
        );
        return;
      }

      const extension = path.extname(file.originalname).toLowerCase();
      const mimeAllowed = rule.mimeTypes.includes(file.mimetype);
      const extensionAllowed =
        !rule.extensions?.length || rule.extensions.map(normalizeExtension).includes(extension);

      if (!mimeAllowed || !extensionAllowed) {
        callback(
          new AppError(
            `Unsupported file "${file.originalname}" (${file.mimetype}).`,
            400,
            ErrorCode.VALIDATION_ERROR,
          ),
        );
        return;
      }

      callback(null, true);
    },
  });

  return middleware.fields(policy.fields.map(({ name, maxCount }) => ({ name, maxCount })));
};

/**
 * Disk-backed multipart adapter for large media. Temporary files are removed
 * after the response finishes or the connection closes. Provider adapters
 * stream from `file.path`, avoiding a full video buffer in Node.js memory.
 */
export const createDiskUploadFields = (
  policy: UploadMiddlewarePolicy,
  namespace = 'docduniya-upload',
): RequestHandler => {
  const fieldRules = new Map(policy.fields.map((field) => [field.name, field]));
  const root = path.join(os.tmpdir(), namespace);
  fs.mkdirSync(root, { recursive: true });

  const uploader = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, root),
      filename: (_req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
      },
    }),
    limits: {
      fileSize: policy.maxFileSizeBytes || 2 * 1024 * 1024 * 1024,
      fieldSize: policy.maxFieldSizeBytes || 1024 * 1024,
      files: policy.maxFiles || policy.fields.reduce((sum, field) => sum + field.maxCount, 0),
    },
    fileFilter: (_req, file, callback) => {
      const rule = fieldRules.get(file.fieldname);
      if (!rule) {
        callback(
          new AppError(
            `Unexpected upload field "${file.fieldname}"`,
            400,
            ErrorCode.VALIDATION_ERROR,
          ),
        );
        return;
      }
      const extension = path.extname(file.originalname).toLowerCase();
      const mimeAllowed = rule.mimeTypes.includes(file.mimetype);
      const extensionAllowed =
        !rule.extensions?.length || rule.extensions.map(normalizeExtension).includes(extension);
      if (!mimeAllowed || !extensionAllowed) {
        callback(
          new AppError(
            `Unsupported file "${file.originalname}" (${file.mimetype}).`,
            400,
            ErrorCode.VALIDATION_ERROR,
          ),
        );
        return;
      }
      callback(null, true);
    },
  }).fields(policy.fields.map(({ name, maxCount }) => ({ name, maxCount })));

  return (req: Request, res: Response, next: NextFunction) => {
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const paths = Object.values(files || {})
        .flat()
        .map((file) => file.path)
        .filter((filePath): filePath is string => Boolean(filePath));
      void Promise.allSettled(paths.map((filePath) => fs.promises.rm(filePath, { force: true })));
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);
    uploader(req, res, next);
  };
};

export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
] as const;

export const VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
] as const;

export const createSingleImageUpload = (fieldName = 'image', maxFileSizeBytes = 10 * 1024 * 1024) =>
  createUploadFields({
    fields: [
      {
        name: fieldName,
        maxCount: 1,
        mimeTypes: IMAGE_MIME_TYPES,
        extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'],
      },
    ],
    maxFileSizeBytes,
    maxFiles: 1,
  });

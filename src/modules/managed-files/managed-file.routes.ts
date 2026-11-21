import { Router } from 'express';
import { uploadLimiter } from '../../middlewares/rate-limit.js';
import { validate } from '../../middlewares/validate.js';
import { PERMISSIONS, protect, requirePermission } from '../admin/auth/index.js';
import {
  createUploadFields,
  DOCUMENT_MIME_TYPES,
  IMAGE_MIME_TYPES,
  VIDEO_MIME_TYPES,
} from '../file-manager/index.js';
import * as controller from './managed-file.controller.js';
import {
  fileIdParamsSchema,
  managedFileListSchema,
  updateManagedFileSeoSchema,
  uploadManagedFileSchema,
} from './managed-file.validation.js';

const router = Router();

const upload = createUploadFields({
  maxFileSizeBytes: 50 * 1024 * 1024,
  maxFiles: 1,
  fields: [
    {
      name: 'file',
      maxCount: 1,
      mimeTypes: [
        ...IMAGE_MIME_TYPES,
        ...DOCUMENT_MIME_TYPES,
        ...VIDEO_MIME_TYPES,
        'text/csv',
        'application/json',
        'application/zip',
      ],
      extensions: [
        'jpg',
        'jpeg',
        'png',
        'webp',
        'gif',
        'avif',
        'pdf',
        'doc',
        'docx',
        'txt',
        'csv',
        'json',
        'zip',
        'mp4',
        'webm',
        'mov',
        'avi',
        'mkv',
      ],
    },
  ],
});

const idParams = validate({ params: fileIdParamsSchema });
const listQuery = validate({ query: managedFileListSchema });
// Multer must run before the body is validated: multipart fields only exist afterwards.
const uploadHandlers = [
  uploadLimiter,
  upload,
  validate({ body: uploadManagedFileSchema }),
  controller.upload,
];

router.use(protect);

// ── File manager (files.manage) ─────────────────────────────────────────────
const admin = Router();
admin.use(requirePermission(PERMISSIONS.FILES_MANAGE));
admin.get('/', listQuery, controller.listAll);
admin.post('/', ...uploadHandlers);
admin.patch(
  '/:id/seo',
  idParams,
  validate({ body: updateManagedFileSeoSchema }),
  controller.updateSeo,
);
admin.get('/:id', idParams, controller.getFile);
admin.delete('/:id', idParams, controller.deleteFile);
router.use('/admin', admin);

// ── Own files (any signed-in user) ──────────────────────────────────────────
router.get('/mine', listQuery, controller.listMine);
router.post('/', ...uploadHandlers);
router.get('/:id', idParams, controller.getFile);
router.delete('/:id', idParams, controller.deleteFile);

export default router;

import { Router } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok } from '../../shared/http/handler.js';
import * as documents from './document.service.js';
import * as dto from './document.validation.js';

const router = Router();

router.post(
  '/documents/upload-intents',
  protect,
  ok(
    (req) =>
      documents.createUploadIntent(
        actor(req),
        dto.uploadIntentInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  '/documents/:documentId/complete-upload',
  protect,
  ok(
    (req) =>
      documents.completeUpload(
        actor(req),
        idParam(req, 'documentId'),
        dto.completeUploadInput.parse(req.body),
        idempotencyKey(req),
      ),
    202,
  ),
);
router.post(
  '/documents/:documentId/access',
  protect,
  noStore((req) =>
    documents.requestDocumentAccess(
      actor(req),
      idParam(req, 'documentId'),
      dto.accessInput.parse(req.body),
    ),
  ),
);
router.post(
  '/documents/:documentId/links',
  protect,
  ok(
    (req) =>
      documents.linkDocument(
        actor(req),
        idParam(req, 'documentId'),
        dto.linkInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/me/documents',
  protect,
  noStore((req) => documents.listOwnDocuments(actor(req), dto.documentQuery.parse(req.query))),
);
router.get(
  '/patients/:patientId/documents',
  protect,
  noStore((req) =>
    documents.listPatientDocuments(
      actor(req),
      idParam(req, 'patientId'),
      dto.documentQuery.parse(req.query),
    ),
  ),
);
router.get(
  '/organizations/:organizationId/documents',
  protect,
  noStore((req) =>
    documents.listOrganizationDocuments(
      actor(req),
      idParam(req, 'organizationId'),
      dto.documentQuery.parse(req.query),
    ),
  ),
);
router.post(
  '/organizations/:organizationId/documents/:documentId/release',
  protect,
  ok((req) =>
    documents.releaseToPatient(
      actor(req),
      idParam(req, 'organizationId'),
      idParam(req, 'documentId'),
      dto.releaseInput.parse(req.body).expectedVersion,
      idempotencyKey(req),
    ),
  ),
);

export default router;

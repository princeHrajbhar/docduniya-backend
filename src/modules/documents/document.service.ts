import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { command, conflict, transaction } from '../../shared/application/command.js';
import { actorRef, before, pageOf, scoped, serviceActor } from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ApiError } from '../../utils/api-error.js';
import { authorizeOrganization } from '../access/access.service.js';
import { Membership } from '../access/access.model.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { authorizePatient } from '../patients/patient.service.js';
import { PatientRegistration } from '../patients/patient.model.js';
import { recordChange, recordRead } from '../operations/operation.service.js';
import { DoctorVerificationCase } from '../providers/provider.model.js';
import { activeGrant } from '../privacy/grant.service.js';
import { authorizeClinical } from '../clinical/clinical.policy.js';
import { Encounter } from '../clinical/clinical.model.js';
import { ClinicalDocument, DocumentLink, DocumentVersion } from './document.model.js';
import { privateStore } from './private-storage.js';
import { malwareScanner, ScannerUnavailableError, sniffMimeType } from './scanner.js';
import type {
  accessInput,
  completeUploadInput,
  documentQuery,
  linkInput,
  uploadIntentInput,
} from './document.validation.js';

type DocumentRow = ReturnType<typeof ClinicalDocument.hydrate>;
const UPLOAD_WINDOW_SECONDS = 15 * 60;
const DOWNLOAD_SECONDS = 60;
const maxBytes = () => env.PRIVATE_DOCUMENT_MAX_MB * 1024 * 1024;

/** Custodian-side write authority. Organization documents need clinical documents permission. */
async function authorizeCustodian(
  actor: CommandActor,
  document: DocumentRow,
  session?: ClientSession,
) {
  const custody = document.custody;
  if (custody.kind === 'PATIENT')
    return authorizePatient(
      actor,
      String(custody.patientId),
      'medical.upload',
      session,
      Boolean(session),
    );
  if (custody.kind === 'USER') {
    if (String(custody.userId) !== actor.userId) throw ApiError.notFound();
    return;
  }
  if (!session)
    return authorizeOrganization(actor, String(custody.organizationId), 'documents.manage');
  return scoped(actor, String(custody.organizationId), 'documents.manage', session);
}

export async function createUploadIntent(
  actor: CommandActor,
  input: z.infer<typeof uploadIntentInput>,
  key: string,
) {
  if (input.sizeBytes > maxBytes())
    throw ApiError.badRequest(`Files are limited to ${env.PRIVATE_DOCUMENT_MAX_MB} MB`);
  const store = privateStore();
  const scopeKey = input.custody.kind === 'ORGANIZATION' ? input.custody.organizationId : 'self';
  const result = await command(
    actor,
    scopeKey,
    'document.upload-intent',
    key,
    input,
    async (session) => {
      let custody: Record<string, string>;
      let subjectPatientId: string | undefined;
      let patientRegistrationId: string | undefined;
      if (input.custody.kind === 'PATIENT') {
        await authorizePatient(actor, input.custody.patientId, 'medical.upload', session, true);
        custody = { kind: 'PATIENT', patientId: input.custody.patientId };
        subjectPatientId = input.custody.patientId;
      } else if (input.custody.kind === 'ORGANIZATION') {
        const access = await authorizeClinical(
          actor,
          input.custody.organizationId,
          input.custody.patientId,
          'documents.manage',
          { session },
        );
        custody = { kind: 'ORGANIZATION', organizationId: input.custody.organizationId };
        subjectPatientId = input.custody.patientId;
        patientRegistrationId = String(access.registration._id);
      } else custody = { kind: 'USER', userId: actor.userId };
      const id = randomUUID().replaceAll('-', '');
      const [document] = await ClinicalDocument.create(
        [
          {
            ...stamp(actor.userId),
            custody,
            subjectPatientId,
            patientRegistrationId,
            category: input.category,
            classification:
              input.custody.kind === 'USER'
                ? 'RESTRICTED'
                : input.category === 'IDENTITY'
                  ? 'RESTRICTED'
                  : 'CLINICAL',
            title: input.title,
            uploadedBy: actor.userId,
            pendingUpload: {
              key: `quarantine/${id}`,
              expectedMimeType: input.mimeType,
              sizeBytes: input.sizeBytes,
              originalName: input.originalName,
            },
            uploadExpiresAt: new Date(Date.now() + UPLOAD_WINDOW_SECONDS * 1000),
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId:
            input.custody.kind === 'ORGANIZATION' ? input.custody.organizationId : undefined,
          patientId: subjectPatientId,
          action: 'DocumentUploadAuthorized',
          resourceType: 'document',
          resourceId: String(document!._id),
          version: 0,
        },
        session,
      );
      return { id: String(document!._id), version: 0 };
    },
  );
  const document = await ClinicalDocument.findById(result.id);
  if (!document?.pendingUpload || document.status !== 'PENDING_UPLOAD')
    return { ...result, status: document?.status };
  // The URL is bound to the exact key, content type and length.
  const uploadUrl = await store.presignUpload(
    document.pendingUpload.key,
    document.pendingUpload.expectedMimeType,
    document.pendingUpload.sizeBytes,
    UPLOAD_WINDOW_SECONDS,
  );
  return {
    ...result,
    status: document.status,
    upload: {
      method: 'PUT',
      url: uploadUrl,
      headers: { 'Content-Type': document.pendingUpload.expectedMimeType },
      expiresAt: document.uploadExpiresAt,
    },
  };
}

/** The browser's completion message is only a hint; the server verifies the stored object. */
export async function completeUpload(
  actor: CommandActor,
  documentId: string,
  input: z.infer<typeof completeUploadInput>,
  key: string,
) {
  const preview = await ClinicalDocument.findById(documentId);
  if (!preview) throw ApiError.notFound();
  await authorizeCustodian(actor, preview);
  const pending = preview.pendingUpload;
  const object = pending ? await privateStore().head(pending.key) : undefined;
  return command(actor, 'self', `document.complete:${documentId}`, key, input, async (session) => {
    const document = await ClinicalDocument.findOne({
      _id: documentId,
      version: input.expectedVersion,
    }).session(session);
    if (!document) conflict();
    await authorizeCustodian(actor, document, session);
    if (document.status !== 'PENDING_UPLOAD' || !document.pendingUpload)
      conflict('This upload is not pending');
    if (!document.uploadExpiresAt || document.uploadExpiresAt <= new Date()) {
      document.status = 'REJECTED';
      document.rejectionReason = 'UPLOAD_EXPIRED';
    } else if (!object)
      throw new ApiError(409, 'The file has not been uploaded yet', undefined, 'UPLOAD_MISSING');
    else if (
      object.sizeBytes !== document.pendingUpload.sizeBytes ||
      (object.contentType && object.contentType !== document.pendingUpload.expectedMimeType)
    ) {
      document.status = 'REJECTED';
      document.rejectionReason = 'UPLOAD_MISMATCH';
    } else {
      document.status = 'QUARANTINED';
      document.nextScanAt = new Date();
    }
    document.updatedBy = { kind: 'USER', id: actor.userId };
    await document.save({ session });
    await recordChange(
      actor,
      {
        organizationId: document.custody.organizationId
          ? String(document.custody.organizationId)
          : undefined,
        patientId: document.subjectPatientId ? String(document.subjectPatientId) : undefined,
        action: document.status === 'QUARANTINED' ? 'DocumentQuarantined' : 'DocumentRejected',
        resourceType: 'document',
        resourceId: documentId,
        version: document.version,
        reason: document.rejectionReason ?? undefined,
      },
      session,
    );
    return { id: documentId, version: document.version };
  });
}

/**
 * Scans quarantined objects. Only the exact scanned bytes are promoted to an immutable available
 * version. A scanner outage leaves files quarantined; a failed check rejects the document.
 */
export async function scanQuarantinedDocuments(limit = 10): Promise<number> {
  const scanner = malwareScanner();
  if (!scanner) return 0;
  let handled = 0;
  for (let index = 0; index < limit; index += 1) {
    const now = new Date();
    const document = await ClinicalDocument.findOneAndUpdate(
      {
        $or: [
          { status: 'QUARANTINED', nextScanAt: { $lte: now } },
          { status: 'SCANNING', scanLeaseUntil: { $lt: now } },
        ],
      },
      {
        $set: { status: 'SCANNING', scanLeaseUntil: new Date(now.getTime() + 5 * 60_000) },
        $inc: { scanAttempts: 1, version: 1 },
      },
      { returnDocument: 'after', sort: { nextScanAt: 1 } },
    );
    if (!document?.pendingUpload) break;
    const pending = document.pendingUpload;
    const store = privateStore();
    const actor = serviceActor('document-scanner', randomUUID());
    let outcome:
      | { status: 'CLEAN'; content: Buffer; sha256: string; engine: string; engineVersion: string }
      | { status: 'REJECTED'; reason: string }
      | { status: 'RETRY' };
    try {
      const content = await store.read(pending.key, maxBytes());
      if (content.length !== pending.sizeBytes)
        outcome = { status: 'REJECTED', reason: 'SIZE_MISMATCH' };
      else if (sniffMimeType(content) !== pending.expectedMimeType)
        outcome = { status: 'REJECTED', reason: 'CONTENT_TYPE_MISMATCH' };
      else {
        const verdict = await scanner.scan(content);
        outcome =
          verdict.status === 'CLEAN'
            ? {
                status: 'CLEAN',
                content: Buffer.from(content),
                sha256: createHash('sha256').update(content).digest('hex'),
                engine: verdict.engine,
                engineVersion: verdict.version,
              }
            : { status: 'REJECTED', reason: 'MALWARE_DETECTED' };
      }
    } catch (error) {
      if (!(error instanceof ScannerUnavailableError))
        logger.warn({ err: error, documentId: String(document._id) }, 'Document scan deferred');
      outcome = { status: 'RETRY' };
    }
    let availableKey: string | undefined;
    let objectVersion: string | undefined;
    if (outcome.status === 'CLEAN') {
      availableKey = `available/${document._id}/v${document.versionCount + 1}-${randomUUID()}`;
      try {
        objectVersion = (
          await store.putImmutable(availableKey, outcome.content, pending.expectedMimeType)
        ).versionId;
      } catch (error) {
        logger.warn({ err: error }, 'Document promotion deferred');
        outcome = { status: 'RETRY' };
      }
    }
    const final = outcome;
    await transaction(async (session) => {
      const current = await ClinicalDocument.findOne({
        _id: document._id,
        version: document.version,
        status: 'SCANNING',
      }).session(session);
      if (!current) return;
      if (final.status === 'RETRY') {
        current.status = 'QUARANTINED';
        current.nextScanAt = new Date(
          Date.now() + Math.min(2 ** current.scanAttempts, 64) * 60_000,
        );
        current.scanLeaseUntil = undefined;
        current.updatedBy = actorRef(actor);
        await current.save({ session });
        return;
      }
      if (final.status === 'REJECTED') {
        current.status = 'REJECTED';
        current.rejectionReason = final.reason;
      } else {
        const [version] = await DocumentVersion.create(
          [
            {
              documentId: current._id,
              versionNumber: current.versionCount + 1,
              file: {
                provider: store.provider,
                bucket: store.bucket,
                key: availableKey!,
                objectVersion,
                sha256: final.sha256,
                sizeBytes: pending.sizeBytes,
                mimeType: pending.expectedMimeType,
              },
              originalName: pending.originalName,
              scan: {
                status: 'CLEAN',
                engine: final.engine,
                version: final.engineVersion,
                scannedAt: new Date(),
              },
              availableAt: new Date(),
              createdBy: actorRef(actor),
            },
          ],
          { session },
        );
        current.status = 'AVAILABLE';
        current.currentVersionId = version!._id;
        current.versionCount += 1;
      }
      current.pendingUpload = undefined;
      current.scanLeaseUntil = undefined;
      current.updatedBy = actorRef(actor);
      await current.save({ session });
      await recordChange(
        actor,
        {
          organizationId: current.custody.organizationId
            ? String(current.custody.organizationId)
            : undefined,
          patientId: current.subjectPatientId ? String(current.subjectPatientId) : undefined,
          action: current.status === 'AVAILABLE' ? 'DocumentAvailable' : 'DocumentRejected',
          resourceType: 'document',
          resourceId: String(current._id),
          version: current.version,
          reason: current.rejectionReason ?? undefined,
        },
        session,
      );
    });
    if (final.status !== 'RETRY') await store.remove(pending.key).catch(() => undefined);
    handled += 1;
  }
  return handled;
}

/** Read authority for each custody kind; every successful decision is audited before disclosure. */
async function authorizeRead(actor: CommandActor, document: DocumentRow, purpose: string) {
  const custody = document.custody;
  const subject = document.subjectPatientId ? String(document.subjectPatientId) : undefined;
  if (custody.kind === 'PATIENT') {
    await authorizePatient(actor, String(custody.patientId), 'medical.read');
    return;
  }
  if (custody.kind === 'USER') {
    if (String(custody.userId) === actor.userId) return;
    if (purpose !== 'CREDENTIAL_REVIEW') throw ApiError.notFound();
    await requirePlatformPermission(actor, PERMISSIONS.DOCTORS_VERIFY);
    const links = await DocumentLink.find({
      documentId: document._id,
      'target.type': 'doctorVerificationCase',
      relationship: 'EVIDENCE',
    }).lean();
    if (
      !(await DoctorVerificationCase.exists({ _id: { $in: links.map((link) => link.target.id) } }))
    )
      throw ApiError.notFound();
    return;
  }
  const organizationId = String(custody.organizationId);
  if (purpose === 'PATIENT_ACCESS') {
    if (!subject || !document.releasedToPatientAt) throw ApiError.notFound();
    await authorizePatient(actor, subject, 'medical.read');
    return;
  }
  if (!subject) {
    // Organization records without a patient subject (contracts, licences) are administrative.
    await authorizeOrganization(actor, organizationId, 'documents.read', { activeProvider: true });
    return;
  }
  try {
    await authorizeClinical(actor, organizationId, subject, 'documents.read');
    return;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
  // Another provider may read only under a current, unwithdrawn patient grant.
  const memberships = await Membership.find({ userId: actor.userId, status: 'ACTIVE' })
    .select({ organizationId: 1 })
    .lean();
  for (const membership of memberships) {
    const recipient = String(membership.organizationId);
    if (recipient === organizationId) continue;
    const grant = await activeGrant(subject, { organizationId: recipient }, 'documents');
    if (!grant) continue;
    // The consent's record period and purposes bound what it discloses.
    const recordedAt = document.createdAt;
    if (grant.recordPeriodStart && recordedAt < grant.recordPeriodStart) continue;
    if (grant.recordPeriodEnd && recordedAt >= grant.recordPeriodEnd) continue;
    if (!grant.purpose.split(',').includes(purpose)) continue;
    // Only the recipient's treating clinicians read shared clinical documents, never its
    // administrators: clinical permission, local registration and a care relationship.
    try {
      await authorizeClinical(actor, recipient, subject, 'clinical.read');
      return;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  throw ApiError.notFound();
}

export async function requestDocumentAccess(
  actor: CommandActor,
  documentId: string,
  input: z.infer<typeof accessInput>,
) {
  const document = await ClinicalDocument.findById(documentId);
  if (!document) throw ApiError.notFound();
  await authorizeRead(actor, document, input.purpose);
  if (document.status !== 'AVAILABLE' || !document.currentVersionId)
    throw new ApiError(409, 'The document is not available', undefined, 'DOCUMENT_NOT_AVAILABLE');
  const version = await DocumentVersion.findById(document.currentVersionId);
  if (!version) throw ApiError.notFound();
  // Durable audit of issuance precedes disclosure. Issuance is not proof of download.
  await recordRead(
    actor,
    'document',
    documentId,
    document.custody.organizationId ? String(document.custody.organizationId) : undefined,
    document.subjectPatientId ? String(document.subjectPatientId) : undefined,
  );
  const extension = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
  }[version.file.mimeType];
  const url = await privateStore().presignDownload(version.file.key, {
    versionId: version.file.objectVersion ?? undefined,
    filename: `document-${documentId}-v${version.versionNumber}.${extension}`,
    mimeType: version.file.mimeType,
    expiresSeconds: DOWNLOAD_SECONDS,
  });
  return {
    documentId,
    versionNumber: version.versionNumber,
    sha256: version.file.sha256,
    url,
    expiresAt: new Date(Date.now() + DOWNLOAD_SECONDS * 1000),
  };
}

export async function linkDocument(
  actor: CommandActor,
  documentId: string,
  input: z.infer<typeof linkInput>,
  key: string,
) {
  return command(actor, 'self', `document.link:${documentId}`, key, input, async (session) => {
    const document = await ClinicalDocument.findById(documentId).session(session);
    if (!document) throw ApiError.notFound();
    await authorizeCustodian(actor, document, session);
    let organizationId: string | undefined;
    if (input.target.type === 'doctorVerificationCase') {
      if (document.custody.kind !== 'USER')
        throw ApiError.badRequest('Credential evidence must be in personal custody');
      const review = await DoctorVerificationCase.findOne({
        _id: input.target.id,
        submittedBy: actor.userId,
      }).session(session);
      if (!review) throw ApiError.notFound('Review case is unavailable');
    } else {
      if (document.custody.kind !== 'ORGANIZATION')
        throw ApiError.badRequest('Only provider documents can be attached to clinical records');
      organizationId = String(document.custody.organizationId);
      if (input.target.type === 'encounter') {
        const encounter = await Encounter.findOne({
          _id: input.target.id,
          organizationId,
          patientId: document.subjectPatientId,
        }).session(session);
        if (!encounter) throw ApiError.notFound('Encounter is unavailable');
      }
    }
    const [link] = await DocumentLink.create(
      [
        {
          documentId,
          target: input.target,
          organizationId,
          relationship: input.relationship,
          createdBy: { kind: 'USER', id: actor.userId },
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId,
        patientId: document.subjectPatientId ? String(document.subjectPatientId) : undefined,
        action: 'DocumentLinked',
        resourceType: 'documentLink',
        resourceId: String(link!._id),
        version: 0,
      },
      session,
    );
    return { id: String(link!._id), version: 0 };
  });
}

/** Explicit provider release of a document to the patient portal. */
export async function releaseToPatient(
  actor: CommandActor,
  organizationId: string,
  documentId: string,
  expectedVersion: number,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'documents.manage');
  return command(
    actor,
    organizationId,
    `document.release:${documentId}`,
    key,
    { expectedVersion },
    async (session) => {
      const document = await ClinicalDocument.findOne({
        _id: documentId,
        'custody.organizationId': organizationId,
        version: expectedVersion,
      }).session(session);
      if (!document) conflict();
      await authorizeClinical(
        actor,
        organizationId,
        String(document.subjectPatientId),
        'documents.manage',
        { session },
      );
      if (document.status !== 'AVAILABLE') conflict('Only available documents can be released');
      document.releasedToPatientAt = new Date();
      document.updatedBy = { kind: 'USER', id: actor.userId };
      await document.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(document.subjectPatientId),
          action: 'DocumentReleasedToPatient',
          resourceType: 'document',
          resourceId: documentId,
          version: document.version,
        },
        session,
      );
      return { id: documentId, version: document.version };
    },
  );
}

const present = (row: DocumentRow) => ({
  id: String(row._id),
  custody: row.custody.kind,
  organizationId: row.custody.organizationId ? String(row.custody.organizationId) : undefined,
  subjectPatientId: row.subjectPatientId ? String(row.subjectPatientId) : undefined,
  category: row.category,
  title: row.title,
  status: row.status,
  rejectionReason: row.rejectionReason,
  releasedToPatientAt: row.releasedToPatientAt,
  createdAt: row.get('createdAt') as Date,
  version: row.version,
});

/** Patient portal: own uploads plus provider documents explicitly released to the patient. */
export async function listPatientDocuments(
  actor: CommandActor,
  patientId: string,
  query: z.infer<typeof documentQuery>,
) {
  await authorizePatient(actor, patientId, 'medical.read');
  const rows = await ClinicalDocument.find({
    $or: [
      { 'custody.patientId': patientId },
      { subjectPatientId: patientId, releasedToPatientAt: { $exists: true } },
    ],
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1);
  return pageOf(rows, query.limit, present);
}

export async function listOrganizationDocuments(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof documentQuery>,
) {
  if (!query.patientId) throw ApiError.badRequest('Choose a patient');
  await authorizeClinical(actor, organizationId, query.patientId, 'documents.read');
  const registration = await PatientRegistration.exists({
    organizationId,
    patientId: query.patientId,
  });
  if (!registration) throw ApiError.notFound();
  const rows = await ClinicalDocument.find({
    'custody.organizationId': organizationId,
    subjectPatientId: query.patientId,
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1);
  return pageOf(rows, query.limit, present);
}

export async function listOwnDocuments(actor: CommandActor, query: z.infer<typeof documentQuery>) {
  const rows = await ClinicalDocument.find({
    'custody.userId': actor.userId,
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1);
  return pageOf(rows, query.limit, present);
}

/** Expires abandoned upload intents. Nothing is ever made available from them. */
export async function expireAbandonedUploads(): Promise<number> {
  const result = await ClinicalDocument.updateMany(
    { status: 'PENDING_UPLOAD', uploadExpiresAt: { $lt: new Date(Date.now() - 3600_000) } },
    { $set: { status: 'REJECTED', rejectionReason: 'UPLOAD_EXPIRED' }, $inc: { version: 1 } },
  );
  return result.modifiedCount;
}

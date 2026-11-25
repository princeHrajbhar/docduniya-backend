import { createHash } from 'node:crypto';
import { Types, type ClientSession, type Document } from 'mongoose';
import { canonical } from '../../shared/application/command.js';
import { actorRef, type OperationActor } from '../../shared/application/scope.js';
import { ClinicalRevision, RecordSignature, type SignableType } from './clinical.model.js';

/** Converts BSON values into stable JSON primitives before hashing. */
export function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Types.ObjectId) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Types.Decimal128) return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const plain = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(plain)
        .filter(([key]) => key !== '_id' || plain._id instanceof Types.ObjectId)
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

/** Allowlisted content fields per resource; workflow metadata is excluded from signed content. */
const CONTENT_FIELDS: Record<SignableType, string[]> = {
  clinicalNote: ['noteType', 'authorId', 'encounterId', 'sections', 'reviewState', 'addendumToId'],
  diagnosis: ['encounterId', 'conditionId', 'code', 'rank', 'use', 'certainty', 'authorId'],
  prescription: [
    'number',
    'encounterId',
    'prescriberId',
    'registrationId',
    'facilityId',
    'issuedAt',
    'validUntil',
    'patientSnapshot',
    'prescriberSnapshot',
    'supersedesId',
  ],
  allergy: [
    'substance',
    'category',
    'clinicalStatus',
    'verificationStatus',
    'criticality',
    'reactions',
    'onset',
    'note',
    'provenance',
  ],
  condition: [
    'code',
    'clinicalStatus',
    'verificationStatus',
    'onset',
    'abatement',
    'severity',
    'note',
    'provenance',
  ],
  medicationStatement: [
    'medication',
    'drugId',
    'status',
    'dosageText',
    'periodStart',
    'periodEnd',
    'sourcePrescriptionItemId',
    'provenance',
  ],
  observation: [
    'category',
    'code',
    'valueType',
    'valueQuantity',
    'valueText',
    'valueCode',
    'valueBoolean',
    'status',
    'effectiveAt',
    'referenceRange',
    'interpretation',
    'serviceOrderId',
    'specimenId',
    'performerId',
  ],
  immunization: [
    'vaccine',
    'status',
    'occurrenceAt',
    'doseText',
    'lotNumber',
    'route',
    'site',
    'performerId',
    'primarySource',
    'reasonNotDone',
    'provenance',
  ],
  diagnosticReport: [
    'reportNumber',
    'serviceOrderIds',
    'specimenIds',
    'code',
    'resultIds',
    'conclusion',
    'status',
    'issuedAt',
    'resultsInterpreterId',
    'performerOrganizationId',
  ],
  serviceOrder: [
    'orderNumber',
    'kind',
    'code',
    'testCatalogId',
    'requestedBy',
    'priority',
    'reason',
    'instructions',
    'performingFacilityId',
  ],
};

export function snapshotOf(type: SignableType, row: Document, extra: Record<string, unknown> = {}) {
  const plain = row.toObject({ depopulate: true }) as Record<string, unknown>;
  const content: Record<string, unknown> = { resourceType: type, id: String(row._id) };
  for (const field of CONTENT_FIELDS[type]) content[field] = plain[field];
  const json = canonical(normalize({ ...content, ...extra }));
  return { json, hash: createHash('sha256').update(json).digest('hex') };
}

type Revisable = Document & {
  organizationId: Types.ObjectId;
  patientId: Types.ObjectId;
  facilityId?: Types.ObjectId | null;
  currentRevisionId?: Types.ObjectId | null;
  revisionCount: number;
};

/**
 * Seals the current content as an immutable revision (and signature, when signed) and advances
 * the head pointer. The caller saves the head in the same transaction.
 */
export async function writeRevision(
  actor: OperationActor,
  type: SignableType,
  row: Revisable,
  kind: 'SIGNED' | 'AMENDED' | 'RECORDED' | 'ENTERED_IN_ERROR',
  reason: string,
  session: ClientSession,
  options: {
    authorId?: Types.ObjectId | string;
    signer?: { practitionerId: string; userId: string; sessionId?: string };
    extra?: Record<string, unknown>;
  } = {},
) {
  const { json, hash } = snapshotOf(type, row, options.extra);
  const revisionId = new Types.ObjectId();
  const signatureId = options.signer ? new Types.ObjectId() : undefined;
  const signedAt = options.signer ? new Date() : undefined;
  const revisionNumber = row.revisionCount + 1;
  await ClinicalRevision.create(
    [
      {
        _id: revisionId,
        organizationId: row.organizationId,
        patientId: row.patientId,
        facilityId: row.facilityId ?? undefined,
        resource: { type, id: row._id },
        revisionNumber,
        previousRevisionId: row.currentRevisionId ?? undefined,
        kind,
        contentSchemaVersion: 1,
        snapshot: json,
        canonicalHash: hash,
        reason,
        authorId: options.authorId,
        recordedBy: actorRef(actor),
        signedAt,
        signatureId,
      },
    ],
    { session },
  );
  if (options.signer)
    await RecordSignature.create(
      [
        {
          _id: signatureId,
          organizationId: row.organizationId,
          patientId: row.patientId,
          revisionId,
          signerId: options.signer.practitionerId,
          userId: options.signer.userId,
          signedAt,
          method: 'AUTHENTICATED_ATTESTATION',
          contentHash: hash,
          authLevel: 'SINGLE_FACTOR',
          sessionId: options.signer.sessionId,
          purpose: 'AUTHOR',
          attestation: 'I reviewed this record and attest that it is accurate.',
        },
      ],
      { session },
    );
  row.set({ currentRevisionId: revisionId, revisionCount: revisionNumber });
  return { revisionId: String(revisionId), hash, revisionNumber };
}

/** Recomputes a stored revision's hash; a mismatch indicates tampering outside the application. */
export async function verifyRevision(revisionId: string) {
  const revision = await ClinicalRevision.findById(revisionId).lean();
  if (!revision) return undefined;
  const hash = createHash('sha256').update(revision.snapshot).digest('hex');
  return {
    revisionId,
    matches: hash === revision.canonicalHash,
    canonicalHash: revision.canonicalHash,
  };
}

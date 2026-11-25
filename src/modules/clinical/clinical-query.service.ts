import { Types, type Model } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { ApiError } from '../../utils/api-error.js';
import { authorizeOrganization } from '../access/access.service.js';
import { authorizePatient } from '../patients/patient.service.js';
import { patientIdentityIds } from '../patients/merge.service.js';
import { Organization } from '../organizations/organization.model.js';
import { recordRead } from '../operations/operation.service.js';
import { activeGrant, periodFilter } from '../privacy/grant.service.js';
import type { ShareableResource } from '../privacy/privacy.model.js';
import { authorizeClinical, chartFilter, ownPractitioner } from './clinical.policy.js';
import {
  Allergy,
  ClinicalNote,
  ClinicalRevision,
  Condition,
  Diagnosis,
  Encounter,
  Immunization,
  MedicationStatement,
  Observation,
  Prescription,
  PrescriptionItem,
  type SignableType,
} from './clinical.model.js';
import { normalize } from './revision.service.js';
import { sharedDiagnosticReports } from '../diagnostics/diagnostic-query.service.js';
import type { sharedRecordsQuery } from './clinical.validation.js';

/** Presents a record without internal fences or actor metadata. */
const plain = (row: { toObject(): unknown }) => {
  const { _id, ...rest } = normalize(row.toObject()) as Record<string, unknown>;
  for (const field of ['authorizationFence', 'createdBy', 'updatedBy']) delete rest[field];
  return { id: _id, ...rest };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry of clinical models
type AnyModel = Model<any>;
/** Signed or final content only; drafts are never shared outside the authoring team. */
const SHARED: Record<
  Exclude<ShareableResource, 'documents' | 'diagnosticReports'>,
  { model: AnyModel; filter: Record<string, unknown>; date: string }
> = {
  encounters: {
    model: Encounter,
    filter: { status: { $in: ['IN_PROGRESS', 'FINISHED'] } },
    date: 'startedAt',
  },
  clinicalNotes: {
    model: ClinicalNote,
    filter: { status: { $in: ['SIGNED', 'AMENDED'] } },
    date: 'signedAt',
  },
  diagnoses: {
    model: Diagnosis,
    filter: { status: { $in: ['SIGNED', 'AMENDED'] } },
    date: 'signedAt',
  },
  observations: {
    model: Observation,
    filter: { status: { $in: ['FINAL', 'AMENDED'] } },
    date: 'effectiveAt',
  },
  allergies: {
    model: Allergy,
    filter: { verificationStatus: { $ne: 'ENTERED_IN_ERROR' } },
    date: 'createdAt',
  },
  conditions: {
    model: Condition,
    filter: { verificationStatus: { $nin: ['ENTERED_IN_ERROR', 'REFUTED'] } },
    date: 'createdAt',
  },
  medicationStatements: { model: MedicationStatement, filter: {}, date: 'createdAt' },
  prescriptions: { model: Prescription, filter: { status: 'SIGNED' }, date: 'issuedAt' },
  immunizations: {
    model: Immunization,
    filter: { status: { $ne: 'ENTERED_IN_ERROR' } },
    date: 'occurrenceAt',
  },
};

/** Current chart summary for the treating team. Missing allergy data is reported as UNKNOWN. */
export async function clinicalSummary(
  actor: CommandActor,
  organizationId: string,
  patientId: string,
) {
  const access = await authorizeClinical(actor, organizationId, patientId, 'clinical.read');
  const scope = chartFilter(access, organizationId, patientId);
  const [allergies, conditions, medications, vitals, encounters, lastNote] = await Promise.all([
    Allergy.find({ ...scope, verificationStatus: { $ne: 'ENTERED_IN_ERROR' } })
      .sort({ _id: -1 })
      .limit(50),
    Condition.find({
      ...scope,
      clinicalStatus: { $in: ['ACTIVE', 'RECURRENCE'] },
      verificationStatus: { $nin: ['ENTERED_IN_ERROR', 'REFUTED'] },
    }).limit(50),
    MedicationStatement.find({ ...scope, status: 'ACTIVE' }).limit(50),
    Observation.find({ ...scope, category: 'VITAL_SIGNS', status: { $in: ['FINAL', 'AMENDED'] } })
      .sort({ effectiveAt: -1 })
      .limit(20),
    Encounter.find(scope).sort({ startedAt: -1 }).limit(10),
    ClinicalNote.findOne({ ...scope, status: { $in: ['SIGNED', 'AMENDED'] } }).sort({
      signedAt: -1,
    }),
  ]);
  const activePrescriptionItems = await PrescriptionItem.find({ ...scope, status: 'ACTIVE' }).limit(
    100,
  );
  await recordRead(actor, 'clinicalSummary', patientId, organizationId, patientId);
  return {
    asOf: new Date(),
    allergies: {
      assessment: allergies.length
        ? 'RECORDED'
        : lastNote?.reviewState?.allergies === 'NONE_KNOWN'
          ? 'NONE_KNOWN'
          : 'UNKNOWN',
      items: allergies.map(plain),
    },
    conditions: conditions.map(plain),
    medications: {
      reported: medications.map(plain),
      prescribed: activePrescriptionItems.map(plain),
    },
    recentVitals: vitals.map(plain),
    encounters: encounters.map(plain),
  };
}

export async function clinicalTimeline(
  actor: CommandActor,
  organizationId: string,
  patientId: string,
) {
  const access = await authorizeClinical(actor, organizationId, patientId, 'clinical.read');
  const scope = chartFilter(access, organizationId, patientId);
  const [encounters, notes, diagnoses, prescriptions, observations] = await Promise.all([
    Encounter.find(scope).sort({ _id: -1 }).limit(50),
    ClinicalNote.find(scope).sort({ _id: -1 }).limit(50),
    Diagnosis.find(scope).sort({ _id: -1 }).limit(50),
    Prescription.find(scope).sort({ _id: -1 }).limit(50),
    Observation.find(scope).sort({ _id: -1 }).limit(50),
  ]);
  const events = [
    ...encounters.map((row) => ({
      type: 'encounter',
      at: row.startedAt ?? row.get('createdAt'),
      record: plain(row),
    })),
    ...notes.map((row) => ({
      type: 'clinicalNote',
      at: row.signedAt ?? row.get('createdAt'),
      record: plain(row),
    })),
    ...diagnoses.map((row) => ({
      type: 'diagnosis',
      at: row.signedAt ?? row.get('createdAt'),
      record: plain(row),
    })),
    ...prescriptions.map((row) => ({
      type: 'prescription',
      at: row.issuedAt ?? row.get('createdAt'),
      record: plain(row),
    })),
    ...observations.map((row) => ({
      type: 'observation',
      at: row.effectiveAt,
      record: plain(row),
    })),
  ].sort((a, b) => new Date(b.at as Date).getTime() - new Date(a.at as Date).getTime());
  await recordRead(actor, 'clinicalTimeline', patientId, organizationId, patientId);
  return { asOf: new Date(), events: events.slice(0, 200) };
}

/** Full prescription with its items, for the treating team. */
export async function getPrescription(
  actor: CommandActor,
  organizationId: string,
  prescriptionId: string,
) {
  const prescription = await Prescription.findOne({ _id: prescriptionId, organizationId });
  if (!prescription) throw ApiError.notFound();
  await authorizeClinical(actor, organizationId, String(prescription.patientId), 'clinical.read', {
    record: prescription,
  });
  const items = await PrescriptionItem.find({ prescriptionId }).sort({ lineNumber: 1 });
  await recordRead(
    actor,
    'prescription',
    prescriptionId,
    organizationId,
    String(prescription.patientId),
  );
  return { ...plain(prescription), items: items.map(plain) };
}

export async function getRevisions(
  actor: CommandActor,
  organizationId: string,
  type: string,
  id: string,
) {
  const revisions = await ClinicalRevision.find({
    organizationId,
    'resource.type': type as SignableType,
    'resource.id': id,
  }).sort({ revisionNumber: 1 });
  if (!revisions.length) throw ApiError.notFound();
  await authorizeClinical(actor, organizationId, String(revisions[0]!.patientId), 'clinical.read', {
    record: { facilityId: revisions[0]!.facilityId, encounterId: undefined },
  });
  await recordRead(actor, 'clinicalRevision', id, organizationId, String(revisions[0]!.patientId));
  return revisions.map((revision) => ({
    id: String(revision._id),
    revisionNumber: revision.revisionNumber,
    kind: revision.kind,
    reason: revision.reason,
    canonicalHash: revision.canonicalHash,
    signedAt: revision.signedAt,
    createdAt: revision.createdAt,
    snapshot: JSON.parse(revision.snapshot) as unknown,
  }));
}

/**
 * Patient-mediated view across every custodian: signed prescriptions, released notes, recorded
 * allergies, active problems, immunizations and visit history. Drafts are never shown.
 */
export async function patientRecords(actor: CommandActor, patientId: string) {
  await authorizePatient(actor, patientId, 'medical.read');
  // Records held under duplicate identities merged into this patient are the patient's too.
  const identities = { $in: await patientIdentityIds(patientId) };
  const [prescriptions, notes, allergies, conditions, immunizations, encounters] =
    await Promise.all([
      Prescription.find({ patientId: identities, status: 'SIGNED' })
        .sort({ issuedAt: -1 })
        .limit(100),
      ClinicalNote.find({
        patientId: identities,
        status: { $in: ['SIGNED', 'AMENDED'] },
        releasedToPatientAt: { $exists: true },
      })
        .sort({ signedAt: -1 })
        .limit(100),
      Allergy.find({
        patientId: identities,
        verificationStatus: { $ne: 'ENTERED_IN_ERROR' },
      }).limit(100),
      Condition.find({
        patientId: identities,
        verificationStatus: { $in: ['CONFIRMED', 'PROVISIONAL'] },
      }).limit(100),
      Immunization.find({ patientId: identities, status: { $ne: 'ENTERED_IN_ERROR' } }).limit(100),
      Encounter.find({ patientId: identities, status: { $in: ['IN_PROGRESS', 'FINISHED'] } })
        .sort({ startedAt: -1 })
        .limit(100),
    ]);
  const items = await PrescriptionItem.find({
    prescriptionId: { $in: prescriptions.map((row) => row._id) },
  }).sort({ lineNumber: 1 });
  const organizations = await Organization.find({
    _id: { $in: [...new Set(encounters.map((row) => String(row.organizationId)))] },
  })
    .select({ displayName: 1 })
    .lean();
  const names = new Map(organizations.map((row) => [String(row._id), row.displayName]));
  await recordRead(actor, 'patientRecords', patientId, undefined, patientId);
  return {
    asOf: new Date(),
    prescriptions: prescriptions.map((row) => ({
      ...plain(row),
      items: items.filter((item) => String(item.prescriptionId) === String(row._id)).map(plain),
    })),
    notes: notes.map(plain),
    allergies: allergies.map(plain),
    conditions: conditions.map(plain),
    immunizations: immunizations.map(plain),
    visits: encounters.map((row) => ({
      id: String(row._id),
      provider: names.get(String(row.organizationId)),
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      mode: row.mode,
      type: row.type.text,
      status: row.status,
    })),
  };
}

/**
 * Another provider's view of records held by other custodians, only under a current patient
 * grant for that resource family and record period. Reads are audited per disclosure.
 */
export async function sharedRecords(
  actor: CommandActor,
  organizationId: string,
  patientId: string,
  query: z.infer<typeof sharedRecordsQuery>,
) {
  await authorizeOrganization(actor, organizationId, 'clinical.read', { activeProvider: true });
  await ownPractitioner(actor);
  if (query.resourceType === 'diagnosticReports')
    return sharedDiagnosticReports(actor, organizationId, patientId);
  const grant = await activeGrant(patientId, { organizationId }, query.resourceType);
  if (!grant) throw ApiError.notFound('No current sharing grant covers these records');
  const config = SHARED[query.resourceType];
  const rows = await config.model
    .find({
      patientId,
      organizationId: { $ne: new Types.ObjectId(organizationId) },
      ...config.filter,
      ...periodFilter(grant, config.date),
    })
    .sort({ _id: -1 })
    .limit(100);
  await recordRead(
    actor,
    `shared.${query.resourceType}`,
    String(grant._id),
    organizationId,
    patientId,
  );
  return { grantId: String(grant._id), expiresAt: grant.expiresAt, items: rows.map(plain) };
}

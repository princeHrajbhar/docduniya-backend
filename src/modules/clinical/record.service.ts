import { Types, type ClientSession, type Model } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { formatNumber, nextNumber } from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { recordChange } from '../operations/operation.service.js';
import { Patient } from '../patients/patient.model.js';
import { Facility } from '../organizations/organization.model.js';
import { authorizeClinical, verifiedPrescriber } from './clinical.policy.js';
import { encounterForWrite } from './encounter.service.js';
import {
  Allergy,
  ClinicalNote,
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
import { writeRevision } from './revision.service.js';
import type {
  addendumInput,
  allergyInput,
  amendInput,
  conditionInput,
  diagnosisInput,
  immunizationInput,
  markErrorInput,
  medicationStatementInput,
  noteInput,
  noteUpdateInput,
  observationInput,
  prescriptionInput,
  signInput,
  stopItemInput,
} from './clinical.validation.js';

const who = (actor: CommandActor) => ({ kind: 'USER' as const, id: actor.userId });
const provenance = (actor: CommandActor, source: 'PATIENT' | 'CLINICIAN' = 'CLINICIAN') => ({
  source,
  recordedAt: new Date(),
  recordedBy: who(actor),
});
const dec = (value?: string) =>
  value === undefined ? undefined : Types.Decimal128.fromString(value);

// ── Longitudinal facts: every confirmed content change saves an immutable revision ────────────

type FactType = 'allergy' | 'condition' | 'medicationStatement' | 'immunization';
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry of clinical models
const FACT_MODELS: Record<FactType, Model<any>> = {
  allergy: Allergy,
  condition: Condition,
  medicationStatement: MedicationStatement,
  immunization: Immunization,
};
type FactInput =
  | z.infer<typeof allergyInput>
  | z.infer<typeof conditionInput>
  | z.infer<typeof medicationStatementInput>
  | z.infer<typeof immunizationInput>;

function factFields(input: FactInput, practitionerId: Types.ObjectId) {
  const result: Record<string, unknown> = { ...input };
  delete result.encounterId;
  delete result.source;
  const dates = ['onset', 'abatement', 'periodStart', 'periodEnd', 'occurrenceAt'] as const;
  for (const field of dates)
    if (typeof result[field] === 'string') result[field] = new Date(result[field] as string);
  if ('primarySource' in input)
    result.performerId = input.primarySource ? practitionerId : undefined;
  return result;
}

export async function recordFact(
  actor: CommandActor,
  organizationId: string,
  patientId: string,
  type: FactType,
  input: FactInput,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `${type}.record:${patientId}`,
    key,
    input,
    async (session) => {
      const { registration, practitioner, facilityId } = await authorizeClinical(
        actor,
        organizationId,
        patientId,
        'clinical.write',
        { session, record: { encounterId: input.encounterId } },
      );
      if (
        input.encounterId &&
        !(await Encounter.exists({ _id: input.encounterId, organizationId, patientId }).session(
          session,
        ))
      )
        throw ApiError.notFound('Encounter is unavailable');
      const model = FACT_MODELS[type];
      const row = new model({
        ...stamp(actor.userId),
        organizationId,
        patientId,
        patientRegistrationId: registration._id,
        facilityId,
        encounterId: input.encounterId,
        provenance: provenance(actor, input.source),
        ...factFields(input, practitioner._id),
      });
      await writeRevision(actor, type, row, 'RECORDED', 'Initial record', session, {
        authorId: practitioner._id,
      });
      await row.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId,
          action: `${type}.recorded`,
          resourceType: type,
          resourceId: String(row._id),
          version: 0,
        },
        session,
      );
      return { id: String(row._id), version: row.version };
    },
  );
}

export async function updateFact(
  actor: CommandActor,
  organizationId: string,
  type: FactType,
  id: string,
  expectedVersion: number,
  reason: string,
  input: FactInput,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `${type}.update:${id}`,
    key,
    { expectedVersion, reason, input },
    async (session) => {
      const row = await FACT_MODELS[type]
        .findOne({ _id: id, organizationId, version: expectedVersion })
        .session(session);
      if (!row) conflict();
      const { practitioner } = await authorizeClinical(
        actor,
        organizationId,
        String(row.patientId),
        'clinical.write',
        { session, record: row },
      );
      if (['ENTERED_IN_ERROR'].includes(row.verificationStatus ?? row.status))
        conflict('This record was entered in error');
      row.set({
        ...factFields(input, practitioner._id),
        provenance: provenance(actor, input.source),
        updatedBy: who(actor),
      });
      await writeRevision(actor, type, row, 'RECORDED', reason, session, {
        authorId: practitioner._id,
      });
      await row.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(row.patientId),
          action: `${type}.updated`,
          resourceType: type,
          resourceId: id,
          version: row.version,
          reason,
        },
        session,
      );
      return { id, version: row.version };
    },
  );
}

// ── Observations ─────────────────────────────────────────────────────────────

export function observationValueFields(value: z.infer<typeof observationInput>['value']) {
  switch (value.type) {
    case 'QUANTITY':
      return {
        valueType: 'QUANTITY',
        valueQuantity: { value: dec(value.value), unit: value.unit },
      };
    case 'TEXT':
      return { valueType: 'TEXT', valueText: value.text };
    case 'CODE':
      return { valueType: 'CODE', valueCode: value.code };
    case 'BOOLEAN':
      return { valueType: 'BOOLEAN', valueBoolean: value.value };
  }
}

export async function recordObservation(
  actor: CommandActor,
  organizationId: string,
  encounterId: string,
  input: z.infer<typeof observationInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `observation.record:${encounterId}`,
    key,
    input,
    async (session) => {
      const { encounter, practitioner } = await encounterForWrite(
        actor,
        organizationId,
        encounterId,
        session,
      );
      const row = new Observation({
        ...stamp(actor.userId),
        organizationId,
        patientId: encounter.patientId,
        patientRegistrationId: encounter.patientRegistrationId,
        facilityId: encounter.facilityId,
        encounterId,
        provenance: { ...provenance(actor), effectiveAt: new Date(input.effectiveAt) },
        category: input.category,
        code: input.code,
        ...observationValueFields(input.value),
        status: input.status,
        effectiveAt: new Date(input.effectiveAt),
        referenceRange: input.referenceRange
          ? {
              ...input.referenceRange,
              low: dec(input.referenceRange.low),
              high: dec(input.referenceRange.high),
            }
          : undefined,
        interpretation: input.interpretation,
        performerId: practitioner._id,
      });
      await writeRevision(actor, 'observation', row, 'RECORDED', 'Initial record', session, {
        authorId: practitioner._id,
      });
      await row.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(encounter.patientId),
          action: 'ObservationRecorded',
          resourceType: 'observation',
          resourceId: String(row._id),
          version: 0,
        },
        session,
      );
      return { id: String(row._id), version: row.version };
    },
  );
}

// ── Notes and diagnoses ──────────────────────────────────────────────────────

export async function createNote(
  actor: CommandActor,
  organizationId: string,
  encounterId: string,
  input: z.infer<typeof noteInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `note.create:${encounterId}`,
    key,
    input,
    async (session) => {
      const { encounter, practitioner } = await encounterForWrite(
        actor,
        organizationId,
        encounterId,
        session,
      );
      const [note] = await ClinicalNote.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            patientId: encounter.patientId,
            patientRegistrationId: encounter.patientRegistrationId,
            facilityId: encounter.facilityId,
            encounterId,
            provenance: provenance(actor),
            noteType: input.noteType,
            authorId: practitioner._id,
            sections: input.sections,
            reviewState: input.reviewState,
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(encounter.patientId),
          action: 'ClinicalNoteDrafted',
          resourceType: 'clinicalNote',
          resourceId: String(note!._id),
          version: 0,
        },
        session,
      );
      return { id: String(note!._id), version: 0 };
    },
  );
}

/** Drafts are editable by their author only; signed notes change through amendment or addendum. */
export async function updateNote(
  actor: CommandActor,
  organizationId: string,
  noteId: string,
  input: z.infer<typeof noteUpdateInput>,
  key: string,
) {
  return command(actor, organizationId, `note.update:${noteId}`, key, input, async (session) => {
    const note = await ClinicalNote.findOne({
      _id: noteId,
      organizationId,
      version: input.expectedVersion,
    }).session(session);
    if (!note) conflict();
    const { practitioner } = await authorizeClinical(
      actor,
      organizationId,
      String(note.patientId),
      'clinical.write',
      { session, record: note },
    );
    if (note.status !== 'DRAFT') conflict('Signed notes are corrected by amendment');
    if (String(note.authorId) !== String(practitioner._id))
      throw ApiError.forbidden('Only the author may edit a draft');
    note.set({ sections: input.sections, reviewState: input.reviewState, updatedBy: who(actor) });
    await note.save({ session });
    return { id: noteId, version: note.version };
  });
}

export async function addAddendum(
  actor: CommandActor,
  organizationId: string,
  noteId: string,
  input: z.infer<typeof addendumInput>,
  key: string,
) {
  return command(actor, organizationId, `note.addendum:${noteId}`, key, input, async (session) => {
    const original = await ClinicalNote.findOne({
      _id: noteId,
      organizationId,
      status: { $in: ['SIGNED', 'AMENDED'] },
    }).session(session);
    if (!original) throw ApiError.notFound('A signed note is required');
    const { practitioner } = await authorizeClinical(
      actor,
      organizationId,
      String(original.patientId),
      'clinical.write',
      { session, record: original },
    );
    const [note] = await ClinicalNote.create(
      [
        {
          ...stamp(actor.userId),
          organizationId,
          patientId: original.patientId,
          patientRegistrationId: original.patientRegistrationId,
          facilityId: original.facilityId,
          encounterId: original.encounterId,
          provenance: provenance(actor),
          noteType: 'ADDENDUM',
          authorId: practitioner._id,
          sections: input.sections,
          addendumToId: original._id,
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId,
        patientId: String(original.patientId),
        action: 'ClinicalAddendumDrafted',
        resourceType: 'clinicalNote',
        resourceId: String(note!._id),
        version: 0,
        reason: input.reason,
      },
      session,
    );
    return { id: String(note!._id), version: 0 };
  });
}

export async function createDiagnosis(
  actor: CommandActor,
  organizationId: string,
  encounterId: string,
  input: z.infer<typeof diagnosisInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `diagnosis.create:${encounterId}`,
    key,
    input,
    async (session) => {
      const { encounter, practitioner } = await encounterForWrite(
        actor,
        organizationId,
        encounterId,
        session,
      );
      if (
        input.conditionId &&
        !(await Condition.exists({
          _id: input.conditionId,
          organizationId,
          patientId: encounter.patientId,
        }).session(session))
      )
        throw ApiError.notFound('Condition is unavailable');
      const [row] = await Diagnosis.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            patientId: encounter.patientId,
            patientRegistrationId: encounter.patientRegistrationId,
            facilityId: encounter.facilityId,
            encounterId,
            provenance: provenance(actor),
            ...input,
            authorId: practitioner._id,
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(encounter.patientId),
          action: 'DiagnosisDrafted',
          resourceType: 'diagnosis',
          resourceId: String(row!._id),
          version: 0,
        },
        session,
      );
      return { id: String(row!._id), version: 0 };
    },
  );
}

// ── Prescriptions ────────────────────────────────────────────────────────────

export async function createPrescription(
  actor: CommandActor,
  organizationId: string,
  encounterId: string,
  input: z.infer<typeof prescriptionInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `prescription.create:${encounterId}`,
    key,
    input,
    async (session) => {
      const { encounter, practitioner } = await encounterForWrite(
        actor,
        organizationId,
        encounterId,
        session,
        'prescriptions.write',
      );
      const patient = await Patient.findById(encounter.patientId).session(session);
      if (!patient) throw ApiError.notFound();
      const [prescription] = await Prescription.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            patientId: encounter.patientId,
            patientRegistrationId: encounter.patientRegistrationId,
            facilityId: encounter.facilityId,
            encounterId,
            provenance: provenance(actor),
            prescriberId: practitioner._id,
            validUntil: new Date(Date.now() + input.validDays * 86400_000),
            itemCount: input.items.length,
            patientSnapshot: {
              name: patient.name.display,
              birthDate: patient.birthDate ?? undefined,
            },
          },
        ],
        { session },
      );
      await PrescriptionItem.create(
        input.items.map((item, index) => ({
          ...stamp(actor.userId),
          organizationId,
          patientId: encounter.patientId,
          patientRegistrationId: encounter.patientRegistrationId,
          facilityId: encounter.facilityId,
          encounterId,
          provenance: provenance(actor),
          prescriptionId: prescription!._id,
          lineNumber: index + 1,
          ...item,
          dosage: item.dosage.map((dose) => ({ ...dose, doseValue: dec(dose.doseValue) })),
        })),
        { session, ordered: true },
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(encounter.patientId),
          action: 'PrescriptionDrafted',
          resourceType: 'prescription',
          resourceId: String(prescription!._id),
          version: 0,
        },
        session,
      );
      return { id: String(prescription!._id), version: 0 };
    },
  );
}

// ── Sign, amend, mark entered in error ───────────────────────────────────────

const SIGN_MODELS = {
  clinicalNote: ClinicalNote,
  diagnosis: Diagnosis,
  prescription: Prescription,
} as const;
type SignType = keyof typeof SIGN_MODELS;
export const isSignType = (type: SignableType): type is SignType => type in SIGN_MODELS;

async function loadForSign(
  type: SignType,
  id: string,
  organizationId: string,
  expectedVersion: number,
  session: ClientSession,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- signable models share the head fields
  const row = await (SIGN_MODELS[type] as Model<any>)
    .findOne({ _id: id, organizationId, version: expectedVersion })
    .session(session);
  if (!row) conflict();
  return row;
}

/**
 * Signing validates authorship, privileges, draft completeness and the expected draft version,
 * then seals an immutable revision and signature with the head change in one transaction.
 */
export async function signRecord(
  actor: CommandActor,
  organizationId: string,
  type: SignType,
  id: string,
  input: z.infer<typeof signInput>,
  key: string,
) {
  return command(actor, organizationId, `${type}.sign:${id}`, key, input, async (session) => {
    const row = await loadForSign(type, id, organizationId, input.expectedVersion, session);
    const permission = type === 'prescription' ? 'prescriptions.write' : 'clinical.sign';
    const { practitioner } = await authorizeClinical(
      actor,
      organizationId,
      String(row.patientId),
      permission,
      { session, record: row },
    );
    if (row.status !== 'DRAFT') conflict('Only drafts can be signed');
    const authorId = type === 'prescription' ? row.prescriberId : row.authorId;
    if (String(authorId) !== String(practitioner._id))
      throw ApiError.forbidden('Only the author may sign this record');
    let extra: Record<string, unknown> = {};
    if (type === 'prescription') {
      const eligibility = await verifiedPrescriber(
        actor,
        organizationId,
        String(row.facilityId),
        session,
      );
      const items = await PrescriptionItem.find({ prescriptionId: id, organizationId })
        .sort({ lineNumber: 1 })
        .session(session);
      if (!items.length || items.length !== row.itemCount)
        throw new ApiError(
          422,
          'Prescription items changed; reload and retry',
          undefined,
          'INCOMPLETE_RECORD',
        );
      const facility = await Facility.findById(row.facilityId).session(session);
      row.number = formatNumber('RX', await nextNumber(organizationId, 'PRESCRIPTION', session));
      row.issuedAt = new Date();
      row.registrationId = eligibility.review.registrationSnapshot.id;
      row.prescriberSnapshot = {
        name: eligibility.doctor.publicName,
        registrationNumber: eligibility.review.registrationSnapshot.registrationNumberNormalized,
        registrationAuthority: eligibility.review.registrationSnapshot.authority,
        facilityName: facility?.name,
      };
      for (const item of items) {
        item.status = 'ACTIVE';
        item.updatedBy = who(actor);
        await item.save({ session });
      }
      // The signed snapshot seals every item together with the prescription header.
      extra = { items: items.map((item) => item.toObject({ depopulate: true })) };
    }
    if (
      type === 'diagnosis' &&
      !(await Encounter.exists({ _id: row.encounterId, organizationId }).session(session))
    )
      throw new ApiError(422, 'A diagnosis needs its encounter', undefined, 'INCOMPLETE_RECORD');
    row.status = 'SIGNED';
    row.signedAt = new Date();
    row.signedBy = practitioner._id;
    row.updatedBy = who(actor);
    await writeRevision(actor, type, row, 'SIGNED', 'Signed by author', session, {
      authorId: practitioner._id,
      signer: { practitionerId: String(practitioner._id), userId: actor.userId },
      extra,
    });
    await row.save({ session });
    if (type === 'clinicalNote' && ['CONSULTATION', 'DISCHARGE_SUMMARY'].includes(row.noteType))
      await Encounter.updateOne(
        { _id: row.encounterId, organizationId },
        { $set: { documentationStatus: 'SIGNED' }, $inc: { version: 1 } },
        { session },
      );
    await recordChange(
      actor,
      {
        organizationId,
        patientId: String(row.patientId),
        action: type === 'prescription' ? 'PrescriptionSigned' : 'ClinicalRecordSigned',
        resourceType: type,
        resourceId: id,
        version: row.version,
      },
      session,
    );
    // Only id/version are stored for idempotent replay; the revision id is read back below.
    return { id, version: row.version };
  }).then(async (result) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- signable models share the head fields
    const revision = await (SIGN_MODELS[type] as Model<any>)
      .findById(id)
      .select({ currentRevisionId: 1 })
      .lean<{ currentRevisionId?: Types.ObjectId }>();
    return {
      ...result,
      revisionId: revision?.currentRevisionId ? String(revision.currentRevisionId) : undefined,
    };
  });
}

/** Amending a signed note keeps every prior revision; the author re-attests the new content. */
export async function amendNote(
  actor: CommandActor,
  organizationId: string,
  noteId: string,
  input: z.infer<typeof amendInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `clinicalNote.amend:${noteId}`,
    key,
    input,
    async (session) => {
      const note = await loadForSign(
        'clinicalNote',
        noteId,
        organizationId,
        input.expectedVersion,
        session,
      );
      const { practitioner } = await authorizeClinical(
        actor,
        organizationId,
        String(note.patientId),
        'clinical.sign',
        { session, record: note },
      );
      if (!['SIGNED', 'AMENDED'].includes(note.status))
        conflict('Only signed notes can be amended');
      if (String(note.authorId) !== String(practitioner._id))
        throw ApiError.forbidden('Another clinician adds an addendum instead');
      note.set({
        sections: input.sections,
        reviewState: input.reviewState,
        status: 'AMENDED',
        correctionReason: input.reason,
        updatedBy: who(actor),
      });
      await writeRevision(actor, 'clinicalNote', note, 'AMENDED', input.reason, session, {
        authorId: practitioner._id,
        signer: { practitionerId: String(practitioner._id), userId: actor.userId },
      });
      await note.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(note.patientId),
          action: 'ClinicalRecordAmended',
          resourceType: 'clinicalNote',
          resourceId: noteId,
          version: note.version,
          reason: input.reason,
        },
        session,
      );
      return { id: noteId, version: note.version };
    },
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry of clinical models
const ERROR_MODELS: Record<string, Model<any>> = {
  ...SIGN_MODELS,
  allergy: Allergy,
  condition: Condition,
  medicationStatement: MedicationStatement,
  immunization: Immunization,
  observation: Observation,
};
/** Marks a record entered in error. The original content and revisions are preserved. */
export async function markEnteredInError(
  actor: CommandActor,
  organizationId: string,
  type: SignableType,
  id: string,
  input: z.infer<typeof markErrorInput>,
  key: string,
) {
  const model = ERROR_MODELS[type];
  if (!model) throw ApiError.badRequest('This record type is corrected in its own workflow');
  return command(actor, organizationId, `${type}.error:${id}`, key, input, async (session) => {
    const row = await model
      .findOne({ _id: id, organizationId, version: input.expectedVersion })
      .session(session);
    if (!row) conflict();
    await authorizeClinical(actor, organizationId, String(row.patientId), 'clinical.sign', {
      session,
      record: row,
    });
    if (type === 'prescription') {
      const items = await PrescriptionItem.find({ prescriptionId: id }).session(session);
      if (items.some((item) => item.dispensedQuantity > 0))
        conflict('Dispensed prescriptions are corrected by stopping items');
      await PrescriptionItem.updateMany(
        { prescriptionId: id },
        { $set: { status: 'ENTERED_IN_ERROR', stopReason: input.reason }, $inc: { version: 1 } },
        { session },
      );
    }
    if ('verificationStatus' in row.toObject() && type !== 'diagnosis')
      row.verificationStatus = 'ENTERED_IN_ERROR';
    else row.status = 'ENTERED_IN_ERROR';
    row.correctionReason = input.reason;
    row.updatedBy = who(actor);
    await writeRevision(actor, type, row, 'ENTERED_IN_ERROR', input.reason, session);
    await row.save({ session });
    await recordChange(
      actor,
      {
        organizationId,
        patientId: String(row.patientId),
        action: 'ClinicalRecordEnteredInError',
        resourceType: type,
        resourceId: id,
        version: row.version,
        reason: input.reason,
      },
      session,
    );
    return { id, version: row.version };
  });
}

/** Discontinues one medication; the signed prescription itself is never rewritten. */
export async function stopPrescriptionItem(
  actor: CommandActor,
  organizationId: string,
  itemId: string,
  input: z.infer<typeof stopItemInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `prescription-item.stop:${itemId}`,
    key,
    input,
    async (session) => {
      const item = await PrescriptionItem.findOne({
        _id: itemId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!item) conflict();
      await authorizeClinical(
        actor,
        organizationId,
        String(item.patientId),
        'prescriptions.write',
        { session, record: item },
      );
      if (item.status !== 'ACTIVE') conflict('Only active items can be stopped');
      item.set({
        status: 'STOPPED',
        stopReason: input.reason,
        stoppedAt: new Date(),
        updatedBy: who(actor),
      });
      await item.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(item.patientId),
          action: 'PrescriptionItemStopped',
          resourceType: 'prescriptionItem',
          resourceId: itemId,
          version: item.version,
          reason: input.reason,
        },
        session,
      );
      return { id: itemId, version: item.version };
    },
  );
}

/** Releases a signed note to the patient portal (prescriptions are released on signing). */
export async function releaseNote(
  actor: CommandActor,
  organizationId: string,
  noteId: string,
  expectedVersion: number,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `clinicalNote.release:${noteId}`,
    key,
    { expectedVersion },
    async (session) => {
      const note = await loadForSign(
        'clinicalNote',
        noteId,
        organizationId,
        expectedVersion,
        session,
      );
      await authorizeClinical(actor, organizationId, String(note.patientId), 'clinical.sign', {
        session,
        record: note,
      });
      if (!['SIGNED', 'AMENDED'].includes(note.status))
        conflict('Only signed notes can be released');
      note.releasedToPatientAt = new Date();
      note.updatedBy = who(actor);
      await note.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(note.patientId),
          action: 'ClinicalNoteReleased',
          resourceType: 'clinicalNote',
          resourceId: noteId,
          version: note.version,
        },
        session,
      );
      return { id: noteId, version: note.version };
    },
  );
}

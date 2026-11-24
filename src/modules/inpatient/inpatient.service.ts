import { Types, type ClientSession } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import {
  before,
  formatNumber,
  nextNumber,
  pageOf,
  scoped,
} from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';
import { authorizeOrganization } from '../access/access.service.js';
import { recordChange, recordRead } from '../operations/operation.service.js';
import { lockActiveFacility } from '../organizations/organization.repository.js';
import { Patient, PatientRegistration } from '../patients/patient.model.js';
import { Practitioner } from '../practitioners/practitioner.model.js';
import { authorizeClinical } from '../clinical/clinical.policy.js';
import { ensureCareAssignment } from '../clinical/encounter.service.js';
import {
  CareTeamAssignment,
  ClinicalNote,
  Observation,
  Prescription,
  PrescriptionItem,
  Visit,
} from '../clinical/clinical.model.js';
import { observationValueFields } from '../clinical/record.service.js';
import { writeRevision } from '../clinical/revision.service.js';
import { FacilityLocation } from '../locations/location.model.js';
import {
  Admission,
  BedAssignment,
  DischargePlan,
  FluidBalanceEntry,
  MedicationAdministration,
} from './inpatient.model.js';
import type {
  administrationCorrectionInput,
  administrationInput,
  admissionInput,
  admitInput,
  bedBoardQuery,
  cancelAdmissionInput,
  censusQuery,
  checklistUpdateInput,
  departInput,
  dischargeInput,
  dischargePlanInput,
  fluidInput,
  inpatientObservationInput,
  transferInput,
} from './inpatient.validation.js';

const who = (actor: CommandActor) => ({ kind: 'USER' as const, id: actor.userId });
const dec = (value?: string) =>
  value === undefined ? undefined : Types.Decimal128.fromString(value);
const DEFAULT_CHECKLIST = [
  { code: 'DISCHARGE_SUMMARY_SIGNED', label: 'Discharge summary signed', required: true },
  { code: 'MEDICINES_RECONCILED', label: 'Discharge medicines reconciled', required: true },
  { code: 'PATIENT_EDUCATION', label: 'Patient and caregiver instructions given', required: true },
  { code: 'FOLLOW_UP_ARRANGED', label: 'Follow-up arranged', required: false },
];

async function admissionFor(
  organizationId: string,
  admissionId: string,
  expectedVersion: number | undefined,
  session: ClientSession,
) {
  const admission = await Admission.findOne({
    _id: admissionId,
    organizationId,
    ...(expectedVersion === undefined ? {} : { version: expectedVersion }),
  }).session(session);
  if (!admission) {
    if (expectedVersion === undefined) throw ApiError.notFound('Admission is unavailable');
    conflict();
  }
  return admission;
}

/** A bed suitable for this patient: same facility, a bed, available and gender-compatible. */
async function suitableBed(
  organizationId: string,
  facilityId: string,
  bedId: string,
  patientId: string,
  session: ClientSession,
) {
  const bed = await FacilityLocation.findOne({
    _id: bedId,
    organizationId,
    facilityId,
    kind: 'BED',
  }).session(session);
  if (!bed || bed.operationalStatus !== 'AVAILABLE')
    throw new ApiError(409, 'The bed is not available', undefined, 'BED_UNAVAILABLE');
  if (bed.genderRestriction) {
    const patient = await Patient.findById(patientId).session(session);
    if (patient?.administrativeSex !== bed.genderRestriction)
      throw new ApiError(
        409,
        'The bed’s ward restriction does not fit this patient',
        undefined,
        'BED_UNSUITABLE',
      );
  }
  return bed;
}

async function occupy(
  actor: CommandActor,
  admission: ReturnType<typeof Admission.hydrate>,
  bedId: string,
  reason: string,
  session: ClientSession,
  transferFromId?: Types.ObjectId,
) {
  const bed = await suitableBed(
    String(admission.organizationId),
    String(admission.facilityId),
    bedId,
    String(admission.patientId),
    session,
  );
  try {
    const [assignment] = await BedAssignment.create(
      [
        {
          ...stamp(actor.userId),
          organizationId: admission.organizationId,
          patientId: admission.patientId,
          patientRegistrationId: admission.patientRegistrationId,
          admissionId: admission._id,
          bedId,
          startedAt: new Date(),
          active: true,
          transferFromId,
          reason,
        },
      ],
      { session },
    );
    bed.operationalStatus = 'OCCUPIED';
    bed.updatedBy = who(actor);
    await bed.save({ session });
    return assignment!;
  } catch (error) {
    if (isDuplicateKeyError(error))
      throw new ApiError(409, 'The bed is already occupied', undefined, 'BED_UNAVAILABLE');
    throw error;
  }
}

async function vacate(
  actor: CommandActor,
  admission: ReturnType<typeof Admission.hydrate>,
  session: ClientSession,
) {
  const current = await BedAssignment.findOne({
    organizationId: admission.organizationId,
    admissionId: admission._id,
    active: true,
  }).session(session);
  if (!current) return undefined;
  current.set({ active: false, endedAt: new Date(), updatedBy: who(actor) });
  await current.save({ session });
  // Physical departure and room cleaning are separate operational steps.
  await FacilityLocation.updateOne(
    { _id: current.bedId, operationalStatus: 'OCCUPIED' },
    { $set: { operationalStatus: 'CLEANING' }, $inc: { version: 1 } },
    { session },
  );
  return current;
}

export async function requestAdmission(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof admissionInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `admission.request:${input.patientId}`,
    key,
    input,
    async (session) => {
      const { registration, practitioner } = await authorizeClinical(
        actor,
        organizationId,
        input.patientId,
        'clinical.write',
        { session, facilityId: input.facilityId, requireCare: false },
      );
      await lockActiveFacility(organizationId, input.facilityId, session);
      if (
        await Admission.exists({
          organizationId,
          patientId: input.patientId,
          status: { $in: ['REQUESTED', 'ADMITTED', 'DISCHARGE_PLANNED', 'CLINICALLY_DISCHARGED'] },
        }).session(session)
      )
        conflict('The patient already has an open admission');
      const [visit] = await Visit.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            patientId: input.patientId,
            patientRegistrationId: registration._id,
            facilityId: input.facilityId,
            type: input.type === 'EMERGENCY' ? 'EMERGENCY' : 'INPATIENT',
            startedAt: new Date(),
          },
        ],
        { session },
      );
      const [admission] = await Admission.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            patientId: input.patientId,
            patientRegistrationId: registration._id,
            visitId: visit!._id,
            facilityId: input.facilityId,
            admissionNumber: formatNumber(
              'ADM',
              await nextNumber(organizationId, 'ADMISSION', session),
            ),
            admittingPractitionerId: practitioner._id,
            type: input.type,
            reason: input.reason,
            requestedAt: new Date(),
          },
        ],
        { session },
      );
      await ensureCareAssignment(
        actor,
        {
          organizationId,
          patientId: input.patientId,
          patientRegistrationId: String(registration._id),
          visitId: String(visit!._id),
          practitionerId: String(practitioner._id),
          userId: actor.userId,
          roleCode: 'ATTENDING',
        },
        session,
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId: input.patientId,
          action: 'AdmissionRequested',
          resourceType: 'admission',
          resourceId: String(admission!._id),
          version: 0,
        },
        session,
      );
      return { id: String(admission!._id), version: 0 };
    },
  );
}

export async function admit(
  actor: CommandActor,
  organizationId: string,
  admissionId: string,
  input: z.infer<typeof admitInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'inpatient.manage');
  return command(
    actor,
    organizationId,
    `admission.admit:${admissionId}`,
    key,
    input,
    async (session) => {
      const admission = await admissionFor(
        organizationId,
        admissionId,
        input.expectedVersion,
        session,
      );
      await scoped(actor, organizationId, 'inpatient.manage', session, {
        facilityId: String(admission.facilityId),
      });
      if (admission.status !== 'REQUESTED') conflict('Only requested admissions can be admitted');
      await occupy(actor, admission, input.bedId, input.reason, session);
      admission.set({ status: 'ADMITTED', admittedAt: new Date(), updatedBy: who(actor) });
      await admission.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(admission.patientId),
          action: 'PatientAdmitted',
          resourceType: 'admission',
          resourceId: admissionId,
          version: admission.version,
        },
        session,
      );
      return { id: admissionId, version: admission.version };
    },
  );
}

/** Ends the old assignment and begins the new one atomically; the bed state follows. */
export async function transferBed(
  actor: CommandActor,
  organizationId: string,
  admissionId: string,
  input: z.infer<typeof transferInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'inpatient.manage');
  return command(
    actor,
    organizationId,
    `admission.transfer:${admissionId}`,
    key,
    input,
    async (session) => {
      const admission = await admissionFor(
        organizationId,
        admissionId,
        input.expectedVersion,
        session,
      );
      await scoped(actor, organizationId, 'inpatient.manage', session, {
        facilityId: String(admission.facilityId),
      });
      if (!['ADMITTED', 'DISCHARGE_PLANNED'].includes(admission.status))
        conflict('Only admitted patients can be transferred');
      const previous = await vacate(actor, admission, session);
      if (previous && String(previous.bedId) === input.targetBedId)
        throw ApiError.badRequest('Choose a different bed');
      await occupy(actor, admission, input.targetBedId, input.reason, session, previous?._id);
      admission.updatedBy = who(actor);
      admission.increment();
      await admission.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(admission.patientId),
          action: 'AdmissionTransferred',
          resourceType: 'admission',
          resourceId: admissionId,
          version: admission.version,
          reason: input.reason,
        },
        session,
      );
      return { id: admissionId, version: admission.version };
    },
  );
}

export async function cancelAdmission(
  actor: CommandActor,
  organizationId: string,
  admissionId: string,
  input: z.infer<typeof cancelAdmissionInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `admission.cancel:${admissionId}`,
    key,
    input,
    async (session) => {
      const admission = await admissionFor(
        organizationId,
        admissionId,
        input.expectedVersion,
        session,
      );
      await authorizeClinical(
        actor,
        organizationId,
        String(admission.patientId),
        'clinical.write',
        { session },
      );
      if (admission.status !== 'REQUESTED')
        conflict('Admitted patients are discharged, not cancelled');
      admission.set({ status: 'CANCELLED', cancelReason: input.reason, updatedBy: who(actor) });
      await admission.save({ session });
      await Visit.updateOne(
        { _id: admission.visitId },
        { $set: { status: 'CLOSED', endedAt: new Date() }, $inc: { version: 1 } },
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(admission.patientId),
          action: 'AdmissionCancelled',
          resourceType: 'admission',
          resourceId: admissionId,
          version: admission.version,
          reason: input.reason,
        },
        session,
      );
      return { id: admissionId, version: admission.version };
    },
  );
}

// ── Nursing documentation ────────────────────────────────────────────────────

async function openAdmission(
  actor: CommandActor,
  organizationId: string,
  admissionId: string,
  session: ClientSession,
) {
  const admission = await admissionFor(organizationId, admissionId, undefined, session);
  const access = await authorizeClinical(
    actor,
    organizationId,
    String(admission.patientId),
    'nursing.write',
    { session, facilityId: String(admission.facilityId) },
  );
  if (!['ADMITTED', 'DISCHARGE_PLANNED'].includes(admission.status))
    conflict('The patient is not currently admitted');
  return { admission, ...access };
}

/** Administration is recorded independently of dispensing; GIVEN needs the actual dose and time. */
export async function recordAdministration(
  actor: CommandActor,
  organizationId: string,
  admissionId: string,
  input: z.infer<typeof administrationInput>,
  key: string,
) {
  return command(actor, organizationId, `mar:${admissionId}`, key, input, async (session) => {
    const { admission, practitioner } = await openAdmission(
      actor,
      organizationId,
      admissionId,
      session,
    );
    const item = await PrescriptionItem.findOne({
      _id: input.prescriptionItemId,
      organizationId,
      patientId: admission.patientId,
      status: 'ACTIVE',
    }).session(session);
    if (!item) throw ApiError.notFound('An active prescription item for this patient is required');
    const prescription = await Prescription.exists({
      _id: item.prescriptionId,
      status: 'SIGNED',
    }).session(session);
    if (!prescription) throw ApiError.notFound('The prescription is not signed');
    let checkerId: Types.ObjectId | undefined;
    if (input.checkerUserId) {
      if (input.checkerUserId === actor.userId)
        throw ApiError.badRequest('A second checker must be another person');
      const checker = await Practitioner.findOne({
        userId: input.checkerUserId,
        status: 'ACTIVE',
      }).session(session);
      if (!checker) throw ApiError.notFound('Checker has no professional profile');
      checkerId = checker._id;
    }
    const [row] = await MedicationAdministration.create(
      [
        {
          organizationId,
          patientId: admission.patientId,
          patientRegistrationId: admission.patientRegistrationId,
          admissionId: admission._id,
          prescriptionItemId: item._id,
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
          administeredAt: input.administeredAt ? new Date(input.administeredAt) : undefined,
          doseValue: dec(input.doseValue),
          doseUnit: input.doseUnit,
          route: input.route,
          performerId: practitioner._id,
          checkerId,
          status: input.status,
          reason: input.reason,
          operationKey: `${admissionId}:${key}`,
          recordedAt: new Date(),
          recordedBy: who(actor),
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId,
        patientId: String(admission.patientId),
        action: `MedicationAdministration.${input.status}`,
        resourceType: 'medicationAdministration',
        resourceId: String(row!._id),
        version: 0,
      },
      session,
    );
    return { id: String(row!._id), version: 0 };
  });
}

/** Corrections are linked ENTERED_IN_ERROR events; the original entry is never rewritten. */
export async function correctAdministration(
  actor: CommandActor,
  organizationId: string,
  administrationId: string,
  input: z.infer<typeof administrationCorrectionInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `mar.correct:${administrationId}`,
    key,
    input,
    async (session) => {
      const original = await MedicationAdministration.findOne({
        _id: administrationId,
        organizationId,
        status: { $ne: 'ENTERED_IN_ERROR' },
      }).session(session);
      if (!original) throw ApiError.notFound();
      if (await MedicationAdministration.exists({ correctsId: original._id }).session(session))
        conflict('Already corrected');
      const { practitioner } = await openAdmission(
        actor,
        organizationId,
        String(original.admissionId),
        session,
      );
      const [row] = await MedicationAdministration.create(
        [
          {
            organizationId,
            patientId: original.patientId,
            patientRegistrationId: original.patientRegistrationId,
            admissionId: original.admissionId,
            prescriptionItemId: original.prescriptionItemId,
            performerId: practitioner._id,
            status: 'ENTERED_IN_ERROR',
            reason: input.reason,
            correctsId: original._id,
            operationKey: `correct:${administrationId}`,
            recordedAt: new Date(),
            recordedBy: who(actor),
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(original.patientId),
          action: 'MedicationAdministrationCorrected',
          resourceType: 'medicationAdministration',
          resourceId: String(row!._id),
          version: 0,
          reason: input.reason,
        },
        session,
      );
      return { id: String(row!._id), version: 0 };
    },
  );
}

export async function recordFluid(
  actor: CommandActor,
  organizationId: string,
  admissionId: string,
  input: z.infer<typeof fluidInput>,
  key: string,
) {
  return command(actor, organizationId, `fluid:${admissionId}`, key, input, async (session) => {
    const { admission, practitioner } = await openAdmission(
      actor,
      organizationId,
      admissionId,
      session,
    );
    if (
      input.correctsId &&
      !(await FluidBalanceEntry.exists({ _id: input.correctsId, admissionId }).session(session))
    )
      throw ApiError.notFound('Corrected entry is unavailable');
    const [row] = await FluidBalanceEntry.create(
      [
        {
          organizationId,
          patientId: admission.patientId,
          patientRegistrationId: admission.patientRegistrationId,
          admissionId: admission._id,
          direction: input.direction,
          type: input.type,
          amountMl: input.amountMl,
          measuredAt: new Date(input.measuredAt),
          recordedByPractitionerId: practitioner._id,
          correctsId: input.correctsId,
          recordedBy: who(actor),
        },
      ],
      { session },
    );
    return { id: String(row!._id), version: 0 };
  });
}

/** Inpatient vitals are observations, never a separate embedded vitals history. */
export async function recordInpatientObservation(
  actor: CommandActor,
  organizationId: string,
  admissionId: string,
  input: z.infer<typeof inpatientObservationInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `inpatient-observation:${admissionId}`,
    key,
    input,
    async (session) => {
      const { admission, practitioner } = await openAdmission(
        actor,
        organizationId,
        admissionId,
        session,
      );
      const row = new Observation({
        ...stamp(actor.userId),
        organizationId,
        patientId: admission.patientId,
        patientRegistrationId: admission.patientRegistrationId,
        provenance: {
          source: 'CLINICIAN',
          recordedAt: new Date(),
          recordedBy: who(actor),
          effectiveAt: new Date(input.effectiveAt),
        },
        category: input.category,
        code: input.code,
        ...observationValueFields(input.value),
        status: input.status,
        effectiveAt: new Date(input.effectiveAt),
        interpretation: input.interpretation,
        admissionId: admission._id,
        performerId: practitioner._id,
      });
      await writeRevision(actor, 'observation', row, 'RECORDED', 'Inpatient observation', session, {
        authorId: practitioner._id,
      });
      await row.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(admission.patientId),
          action: 'InpatientObservationRecorded',
          resourceType: 'observation',
          resourceId: String(row._id),
          version: row.version,
        },
        session,
      );
      return { id: String(row._id), version: row.version };
    },
  );
}

export async function nursingChart(
  actor: CommandActor,
  organizationId: string,
  admissionId: string,
) {
  const admission = await Admission.findOne({ _id: admissionId, organizationId });
  if (!admission) throw ApiError.notFound();
  await authorizeClinical(actor, organizationId, String(admission.patientId), 'clinical.read', {
    facilityId: String(admission.facilityId),
  });
  const since = new Date(Date.now() - 24 * 3600_000);
  const [administrations, fluids, observations, beds] = await Promise.all([
    MedicationAdministration.find({ admissionId }).sort({ recordedAt: -1 }).limit(200).lean(),
    FluidBalanceEntry.find({ admissionId }).sort({ measuredAt: -1 }).limit(500).lean(),
    Observation.find({ admissionId }).sort({ effectiveAt: -1 }).limit(200),
    BedAssignment.find({ admissionId }).sort({ startedAt: 1 }).lean(),
  ]);
  const corrected = new Set(
    fluids.map((row) => String(row.correctsId)).filter((id) => id !== 'undefined'),
  );
  const current = fluids.filter(
    (row) => !corrected.has(String(row._id)) && row.measuredAt >= since,
  );
  const total = (direction: 'INTAKE' | 'OUTPUT') =>
    current
      .filter((row) => row.direction === direction)
      .reduce((sum, row) => sum + row.amountMl, 0);
  await recordRead(actor, 'nursingChart', admissionId, organizationId, String(admission.patientId));
  return {
    admission: {
      id: admissionId,
      number: admission.admissionNumber,
      status: admission.status,
      admittedAt: admission.admittedAt,
    },
    beds: beds.map((row) => ({
      bedId: String(row.bedId),
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      active: row.active,
      reason: row.reason,
    })),
    administrations: administrations.map((row) => ({
      id: String(row._id),
      prescriptionItemId: String(row.prescriptionItemId),
      status: row.status,
      scheduledAt: row.scheduledAt,
      administeredAt: row.administeredAt,
      dose: row.doseValue ? `${row.doseValue.toString()} ${row.doseUnit}` : undefined,
      route: row.route,
      reason: row.reason,
      correctsId: row.correctsId ? String(row.correctsId) : undefined,
    })),
    fluidBalance24h: {
      intakeMl: total('INTAKE'),
      outputMl: total('OUTPUT'),
      netMl: total('INTAKE') - total('OUTPUT'),
    },
    observations: observations.map((row) => row.toJSON()),
  };
}

// ── Discharge ────────────────────────────────────────────────────────────────

export async function createDischargePlan(
  actor: CommandActor,
  organizationId: string,
  admissionId: string,
  input: z.infer<typeof dischargePlanInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `discharge-plan:${admissionId}`,
    key,
    input,
    async (session) => {
      const admission = await admissionFor(organizationId, admissionId, undefined, session);
      const { practitioner } = await authorizeClinical(
        actor,
        organizationId,
        String(admission.patientId),
        'clinical.write',
        { session },
      );
      if (admission.status !== 'ADMITTED') conflict('Only admitted patients get a discharge plan');
      const checklist = [
        ...DEFAULT_CHECKLIST,
        ...input.checklist.filter(
          (entry) => !DEFAULT_CHECKLIST.some((base) => base.code === entry.code),
        ),
      ];
      const [plan] = await DischargePlan.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            patientId: admission.patientId,
            patientRegistrationId: admission.patientRegistrationId,
            admissionId: admission._id,
            plannedAt: new Date(input.plannedAt),
            responsiblePractitionerId: practitioner._id,
            checklist,
          },
        ],
        { session },
      );
      admission.set({ status: 'DISCHARGE_PLANNED', updatedBy: who(actor) });
      await admission.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(admission.patientId),
          action: 'DischargePlanned',
          resourceType: 'dischargePlan',
          resourceId: String(plan!._id),
          version: 0,
        },
        session,
      );
      return { id: String(plan!._id), version: 0 };
    },
  );
}

/** Completing the summary item requires a signed discharge summary for this patient. */
export async function updateChecklist(
  actor: CommandActor,
  organizationId: string,
  planId: string,
  input: z.infer<typeof checklistUpdateInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `discharge-checklist:${planId}:${input.code}`,
    key,
    input,
    async (session) => {
      const plan = await DischargePlan.findOne({
        _id: planId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!plan) conflict();
      await authorizeClinical(actor, organizationId, String(plan.patientId), 'clinical.write', {
        session,
      });
      if (!['DRAFT', 'READY'].includes(plan.status)) conflict('The plan is closed');
      const item = plan.checklist.find((entry) => entry.code === input.code);
      if (!item) throw ApiError.notFound('Checklist item is unavailable');
      if (input.status === 'WAIVED' && (item.required || !input.reason))
        throw ApiError.badRequest(
          'Required items cannot be waived; optional waivers need a reason',
        );
      if (input.code === 'DISCHARGE_SUMMARY_SIGNED') {
        const note = await ClinicalNote.findOne({
          _id: input.summaryNoteId,
          organizationId,
          patientId: plan.patientId,
          noteType: 'DISCHARGE_SUMMARY',
          status: { $in: ['SIGNED', 'AMENDED'] },
        }).session(session);
        if (!note)
          throw new ApiError(
            422,
            'A signed discharge summary is required',
            undefined,
            'INCOMPLETE_RECORD',
          );
        plan.summaryNoteId = note._id;
      }
      if (input.code === 'MEDICINES_RECONCILED' && input.prescriptionId) {
        if (
          !(await Prescription.exists({
            _id: input.prescriptionId,
            organizationId,
            patientId: plan.patientId,
            status: 'SIGNED',
          }).session(session))
        )
          throw ApiError.notFound('Signed discharge prescription is unavailable');
        plan.set('prescriptionId', input.prescriptionId);
      }
      item.set({ status: input.status, by: who(actor), at: new Date(), reason: input.reason });
      plan.status = plan.checklist.every((entry) => !entry.required || entry.status !== 'PENDING')
        ? 'READY'
        : 'DRAFT';
      plan.updatedBy = who(actor);
      await plan.save({ session });
      return { id: planId, version: plan.version };
    },
  );
}

/** Clinical discharge is distinct from physical departure, cleaning and financial closure. */
export async function clinicalDischarge(
  actor: CommandActor,
  organizationId: string,
  admissionId: string,
  input: z.infer<typeof dischargeInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `admission.discharge:${admissionId}`,
    key,
    input,
    async (session) => {
      const admission = await admissionFor(
        organizationId,
        admissionId,
        input.expectedVersion,
        session,
      );
      await authorizeClinical(actor, organizationId, String(admission.patientId), 'clinical.sign', {
        session,
      });
      if (admission.status !== 'DISCHARGE_PLANNED') conflict('Plan the discharge first');
      const plan = await DischargePlan.findOne({
        organizationId,
        admissionId,
        status: 'READY',
      }).session(session);
      if (!plan)
        throw new ApiError(
          409,
          'The discharge checklist is incomplete',
          undefined,
          'DISCHARGE_NOT_READY',
        );
      plan.set({ status: 'COMPLETED', updatedBy: who(actor) });
      await plan.save({ session });
      admission.set({
        status: 'CLINICALLY_DISCHARGED',
        clinicalDischargedAt: new Date(),
        disposition: input.disposition,
        updatedBy: who(actor),
      });
      await admission.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(admission.patientId),
          action: 'PatientClinicallyDischarged',
          resourceType: 'admission',
          resourceId: admissionId,
          version: admission.version,
        },
        session,
      );
      return { id: admissionId, version: admission.version };
    },
  );
}

export async function depart(
  actor: CommandActor,
  organizationId: string,
  admissionId: string,
  input: z.infer<typeof departInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'inpatient.manage');
  return command(
    actor,
    organizationId,
    `admission.depart:${admissionId}`,
    key,
    input,
    async (session) => {
      const admission = await admissionFor(
        organizationId,
        admissionId,
        input.expectedVersion,
        session,
      );
      await scoped(actor, organizationId, 'inpatient.manage', session, {
        facilityId: String(admission.facilityId),
      });
      if (admission.status !== 'CLINICALLY_DISCHARGED')
        conflict('Clinical discharge must precede departure');
      await vacate(actor, admission, session);
      admission.set({ status: 'DEPARTED', departedAt: new Date(), updatedBy: who(actor) });
      await admission.save({ session });
      await Visit.updateOne(
        { _id: admission.visitId, status: 'OPEN' },
        { $set: { status: 'CLOSED', endedAt: new Date() }, $inc: { version: 1 } },
        { session },
      );
      await CareTeamAssignment.updateMany(
        { organizationId, visitId: admission.visitId, status: 'ACTIVE' },
        { $set: { status: 'ENDED', periodEnd: new Date() }, $inc: { version: 1 } },
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(admission.patientId),
          action: 'PatientDeparted',
          resourceType: 'admission',
          resourceId: admissionId,
          version: admission.version,
        },
        session,
      );
      return { id: admissionId, version: admission.version };
    },
  );
}

// ── Operational views ────────────────────────────────────────────────────────

export async function census(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof censusQuery>,
) {
  await authorizeOrganization(actor, organizationId, 'inpatient.manage', {
    facilityId: query.facilityId,
  });
  const rows = await Admission.find({
    organizationId,
    facilityId: query.facilityId,
    status: query.status ?? {
      $in: ['REQUESTED', 'ADMITTED', 'DISCHARGE_PLANNED', 'CLINICALLY_DISCHARGED'],
    },
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  const registrations = await PatientRegistration.find({
    _id: { $in: rows.map((row) => row.patientRegistrationId) },
  })
    .select({ mrn: 1, 'demographicSnapshot.name.display': 1 })
    .lean();
  const beds = await BedAssignment.find({
    admissionId: { $in: rows.map((row) => row._id) },
    active: true,
  }).lean();
  const byRegistration = new Map(registrations.map((row) => [String(row._id), row]));
  const byAdmission = new Map(beds.map((row) => [String(row.admissionId), String(row.bedId)]));
  return pageOf(rows, query.limit, (row) => ({
    id: String(row._id),
    admissionNumber: row.admissionNumber,
    patient: {
      mrn: byRegistration.get(String(row.patientRegistrationId))?.mrn,
      name: byRegistration.get(String(row.patientRegistrationId))?.demographicSnapshot.name.display,
    },
    bedId: byAdmission.get(String(row._id)),
    type: row.type,
    status: row.status,
    financialStatus: row.financialStatus,
    admittedAt: row.admittedAt,
    version: row.version,
  }));
}

export async function bedBoard(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof bedBoardQuery>,
) {
  await authorizeOrganization(actor, organizationId, 'inpatient.manage', {
    facilityId: query.facilityId,
  });
  const beds = await FacilityLocation.find({
    organizationId,
    facilityId: query.facilityId,
    kind: 'BED',
  })
    .sort({ code: 1 })
    .limit(2000)
    .lean();
  const active = await BedAssignment.find({
    organizationId,
    bedId: { $in: beds.map((bed) => bed._id) },
    active: true,
  }).lean();
  const byBed = new Map(active.map((row) => [String(row.bedId), String(row.admissionId)]));
  return beds.map((bed) => ({
    id: String(bed._id),
    code: bed.code,
    name: bed.name,
    parentId: bed.parentId ? String(bed.parentId) : undefined,
    status: bed.operationalStatus,
    genderRestriction: bed.genderRestriction,
    isolationCapable: bed.isolationCapable,
    admissionId: byBed.get(String(bed._id)),
    version: bed.version,
  }));
}

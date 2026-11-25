import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import * as patients from '../../src/modules/patients/patient.service.js';
import * as encounters from '../../src/modules/clinical/encounter.service.js';
import * as records from '../../src/modules/clinical/record.service.js';
import * as queries from '../../src/modules/clinical/clinical-query.service.js';
import * as tasks from '../../src/modules/clinical/task.service.js';
import { verifyRevision } from '../../src/modules/clinical/revision.service.js';
import {
  ClinicalRevision,
  ClinicalTask,
  Prescription,
  PrescriptionItem,
} from '../../src/modules/clinical/clinical.model.js';
import * as privacy from '../../src/modules/privacy/privacy.service.js';
import * as diagnostics from '../../src/modules/diagnostics/diagnostic.service.js';
import * as diagnosticQueries from '../../src/modules/diagnostics/diagnostic-query.service.js';
import { ServiceOrder } from '../../src/modules/diagnostics/diagnostic.model.js';
import * as memberships from '../../src/modules/access/membership.service.js';
import { Membership } from '../../src/modules/access/access.model.js';
import { relayOutbox } from '../../src/modules/operations/outbox.relay.js';
import { Notification } from '../../src/modules/notifications/notification.model.js';
import { PatientRegistration } from '../../src/modules/patients/patient.model.js';
import {
  account,
  key,
  patient,
  platformAdmin,
  professional,
  provider,
  staff,
  startDatabase,
  stopDatabase,
  verifiedDoctor,
  walkIn,
  type Identity,
} from './support.js';

const concept = (text: string) => ({ text, codings: [] });
let owner: Identity;
let reviewer: Identity;
let doctor: Identity;
let clinic: { organizationId: string; facilityId: string };
let patientAccount: Identity;
let patientId: string;

beforeAll(async () => {
  await startDatabase();
  owner = await account();
  reviewer = await platformAdmin();
  doctor = await account();
  clinic = await provider(owner, reviewer);
  await verifiedDoctor(doctor, reviewer, owner, clinic);
  patientAccount = await account();
  patientId = (await patient(patientAccount)).id;
  await patients.registerSelfAtProvider(
    patientAccount.actor,
    patientId,
    { organizationId: clinic.organizationId, facilityId: clinic.facilityId },
    key(),
  );
});
afterAll(stopDatabase);

async function startCare() {
  return encounters.startEncounter(
    doctor.actor,
    clinic.organizationId,
    {
      patientId,
      facilityId: clinic.facilityId,
      queueEntryId: await walkIn(owner, clinic, patientId),
      type: concept('Outpatient consultation'),
      mode: 'IN_PERSON',
      chiefComplaint: 'Fever for three days',
    },
    key(),
  );
}

describe('Outpatient clinical records', () => {
  it('limits chart access to the care team and seals signed notes, diagnoses and prescriptions', async () => {
    const receptionist = await account();
    await staff(owner, receptionist, clinic.organizationId, clinic.facilityId, 'receptionist');
    const colleague = await account();
    await professional(colleague, 'NURSE');
    await staff(owner, colleague, clinic.organizationId, clinic.facilityId, 'nurse');

    const encounter = await startCare();
    await expect(
      queries.clinicalSummary(receptionist.actor, clinic.organizationId, patientId),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      queries.clinicalSummary(colleague.actor, clinic.organizationId, patientId),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      queries.clinicalSummary(owner.actor, clinic.organizationId, patientId),
    ).rejects.toMatchObject({ statusCode: 403 });

    const empty = await queries.clinicalSummary(doctor.actor, clinic.organizationId, patientId);
    expect(empty.allergies.assessment).toBe('UNKNOWN');
    await records.recordFact(
      doctor.actor,
      clinic.organizationId,
      patientId,
      'allergy',
      {
        source: 'PATIENT',
        substance: concept('Penicillin'),
        category: 'DRUG',
        clinicalStatus: 'ACTIVE',
        verificationStatus: 'CONFIRMED',
        criticality: 'HIGH',
        reactions: [],
      },
      key(),
    );
    await records.recordObservation(
      doctor.actor,
      clinic.organizationId,
      encounter.id,
      {
        category: 'VITAL_SIGNS',
        code: concept('Body temperature'),
        value: { type: 'QUANTITY', value: '38.4', unit: 'Cel' },
        effectiveAt: new Date().toISOString(),
        status: 'FINAL',
      },
      key(),
    );

    const note = await records.createNote(
      doctor.actor,
      clinic.organizationId,
      encounter.id,
      {
        noteType: 'CONSULTATION',
        sections: {
          history: 'Fever and myalgia',
          assessment: 'Likely viral illness',
          plan: 'Fluids and paracetamol',
        },
        reviewState: { allergies: 'REVIEWED', medications: 'NONE_KNOWN' },
      },
      key(),
    );
    const signed = await records.signRecord(
      doctor.actor,
      clinic.organizationId,
      'clinicalNote',
      note.id,
      { expectedVersion: note.version, attestation: true },
      key(),
    );
    expect(signed.revisionId).toBeDefined();
    await expect(
      records.updateNote(
        doctor.actor,
        clinic.organizationId,
        note.id,
        {
          expectedVersion: signed.version,
          sections: { history: 'Rewritten' },
          reviewState: { allergies: 'REVIEWED', medications: 'REVIEWED' },
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      ClinicalRevision.updateOne({ _id: signed.revisionId }, { $set: { snapshot: '{}' } }),
    ).rejects.toThrow(/immutable/);
    const amended = await records.amendNote(
      doctor.actor,
      clinic.organizationId,
      note.id,
      {
        expectedVersion: signed.version,
        reason: 'Correct the medication plan',
        sections: {
          history: 'Fever and myalgia',
          assessment: 'Likely viral illness',
          plan: 'Fluids, paracetamol and review in 48 hours',
        },
        reviewState: { allergies: 'REVIEWED', medications: 'NONE_KNOWN' },
      },
      key(),
    );
    const revisions = await queries.getRevisions(
      doctor.actor,
      clinic.organizationId,
      'clinicalNote',
      note.id,
    );
    expect(revisions.map((row) => row.kind)).toEqual(['SIGNED', 'AMENDED']);
    expect((revisions[0]!.snapshot as { sections: { plan: string } }).sections.plan).toBe(
      'Fluids and paracetamol',
    );
    expect((await verifyRevision(revisions[1]!.id))?.matches).toBe(true);

    const diagnosis = await records.createDiagnosis(
      doctor.actor,
      clinic.organizationId,
      encounter.id,
      { code: concept('Viral fever'), rank: 1, use: 'PRIMARY', certainty: 'PROVISIONAL' },
      key(),
    );
    await records.signRecord(
      doctor.actor,
      clinic.organizationId,
      'diagnosis',
      diagnosis.id,
      { expectedVersion: 0, attestation: true },
      key(),
    );

    const draft = await records.createPrescription(
      doctor.actor,
      clinic.organizationId,
      encounter.id,
      {
        validDays: 30,
        items: [
          {
            medication: { name: 'Paracetamol', form: 'Tablet', strength: '500 mg' },
            dosage: [
              {
                doseValue: '1',
                doseUnit: 'tablet',
                route: 'Oral',
                frequencyPerDay: 3,
                timesOfDay: [],
                asNeeded: false,
                durationDays: 3,
                instructions: 'After food',
              },
            ],
            quantity: { value: 9, unit: 'tablet' },
            refillsAllowed: 0,
            substitutionAllowed: true,
          },
        ],
      },
      key(),
    );
    await expect(
      records.signRecord(
        colleague.actor,
        clinic.organizationId,
        'prescription',
        draft.id,
        { expectedVersion: 0, attestation: true },
        key(),
      ),
    ).rejects.toBeDefined();
    await records.signRecord(
      doctor.actor,
      clinic.organizationId,
      'prescription',
      draft.id,
      { expectedVersion: 0, attestation: true },
      key(),
    );
    const prescription = (await Prescription.findById(draft.id))!;
    expect(prescription.number).toMatch(/^RX-/);
    expect(prescription.prescriberSnapshot?.registrationNumber).toBeDefined();
    expect((await PrescriptionItem.findOne({ prescriptionId: draft.id }))!.status).toBe('ACTIVE');

    const portal = await queries.patientRecords(patientAccount.actor, patientId);
    expect(portal.prescriptions).toHaveLength(1);
    expect(portal.notes).toHaveLength(0);
    await records.releaseNote(doctor.actor, clinic.organizationId, note.id, amended.version, key());
    expect((await queries.patientRecords(patientAccount.actor, patientId)).notes).toHaveLength(1);
    await encounters.finishEncounter(
      doctor.actor,
      clinic.organizationId,
      encounter.id,
      (await encounters.getEncounter(doctor.actor, clinic.organizationId, encounter.id)).version,
      key(),
    );

    await relayOutbox(200);
    expect(
      await Notification.countDocuments({
        userId: patientAccount.userId,
        templateCode: 'RECORD_AVAILABLE',
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('grants audited emergency access that must be reviewed by someone else', async () => {
    const nurse = await account();
    await professional(nurse, 'NURSE');
    await staff(owner, nurse, clinic.organizationId, clinic.facilityId, 'nurse');
    await expect(
      queries.clinicalSummary(nurse.actor, clinic.organizationId, patientId),
    ).rejects.toMatchObject({ statusCode: 404 });
    const grant = await privacy.emergencyAccess(
      nurse.actor,
      clinic.organizationId,
      patientId,
      { reason: 'Unresponsive patient at triage needs allergy review' },
      key(),
    );
    expect(
      (await queries.clinicalSummary(nurse.actor, clinic.organizationId, patientId)).allergies
        .items,
    ).toHaveLength(1);
    await expect(
      privacy.reviewEmergencyAccess(
        nurse.actor,
        clinic.organizationId,
        grant.id,
        { expectedVersion: 0, outcome: 'JUSTIFIED', note: 'Self review attempt' },
        key(),
      ),
    ).rejects.toBeDefined();
    await privacy.reviewEmergencyAccess(
      owner.actor,
      clinic.organizationId,
      grant.id,
      { expectedVersion: 0, outcome: 'JUSTIFIED', note: 'Triage emergency confirmed' },
      key(),
    );
    await expect(
      queries.clinicalSummary(nurse.actor, clinic.organizationId, patientId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('shares signed records with another provider only under a current patient grant', async () => {
    const otherOwner = await account();
    const otherDoctor = await account();
    const other = await provider(otherOwner, reviewer);
    await verifiedDoctor(otherDoctor, reviewer, otherOwner, other);
    await expect(
      queries.sharedRecords(otherDoctor.actor, other.organizationId, patientId, {
        resourceType: 'prescriptions',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const consent = await privacy.grantRecordSharing(
      patientAccount.actor,
      patientId,
      {
        recipientOrganizationId: other.organizationId,
        purposes: ['SECOND_OPINION'],
        resourceTypes: ['prescriptions', 'allergies'],
        expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      },
      key(),
    );
    expect(
      (
        await queries.sharedRecords(otherDoctor.actor, other.organizationId, patientId, {
          resourceType: 'prescriptions',
        })
      ).items,
    ).toHaveLength(1);
    await expect(
      queries.sharedRecords(otherDoctor.actor, other.organizationId, patientId, {
        resourceType: 'clinicalNotes',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await privacy.withdrawConsent(
      patientAccount.actor,
      consent.id,
      { expectedVersion: 0, reason: 'Second opinion completed' },
      key(),
    );
    await expect(
      queries.sharedRecords(otherDoctor.actor, other.organizationId, patientId, {
        resourceType: 'prescriptions',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const history = await privacy.patientAccessHistory(patientAccount.actor, patientId, {
      limit: 100,
    });
    expect(history.items.some((row) => row.action === 'shared.prescriptions.read')).toBe(true);
    const exported = await privacy.exportPatientData(patientAccount.actor, patientId);
    expect(exported.clinical.prescriptions).toHaveLength(1);
  });
});

describe('Diagnostics', () => {
  it('runs order, specimen, critical result verification, acknowledgement and amendment', async () => {
    const lab = await account();
    await professional(lab, 'LAB_PROFESSIONAL');
    await staff(owner, lab, clinic.organizationId, clinic.facilityId, 'lab-technician');
    const encounter = await startCare();
    const order = await diagnostics.placeOrder(
      doctor.actor,
      clinic.organizationId,
      encounter.id,
      {
        kind: 'LAB',
        code: concept('Serum potassium'),
        performingFacilityId: clinic.facilityId,
        priority: 'STAT',
        reason: concept('Weakness'),
      },
      key(),
    );
    const worklist = await diagnostics.worklist(lab.actor, clinic.organizationId, {
      facilityId: clinic.facilityId,
      limit: 25,
    });
    expect(worklist.items.map((row) => row.id)).toContain(order.id);
    expect(JSON.stringify(worklist)).not.toContain('Fever');
    await expect(
      diagnostics.collectSpecimen(
        lab.actor,
        clinic.organizationId,
        { serviceOrderIds: [order.id], type: 'Blood', container: 'SST' },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await diagnostics.transitionOrder(
      lab.actor,
      clinic.organizationId,
      order.id,
      { expectedVersion: (await ServiceOrder.findById(order.id))!.version, action: 'accept' },
      key(),
    );
    const specimen = await diagnostics.collectSpecimen(
      lab.actor,
      clinic.organizationId,
      { serviceOrderIds: [order.id], type: 'Blood', container: 'SST' },
      key(),
    );
    const result = {
      serviceOrderId: order.id,
      specimenId: specimen.id,
      code: concept('Potassium'),
      value: { type: 'QUANTITY' as const, value: '6.9', unit: 'mmol/L' },
      effectiveAt: new Date().toISOString(),
      referenceRange: { low: '3.5', high: '5.1', unit: 'mmol/L' },
      interpretation: 'CRITICAL_HIGH' as const,
    };
    await expect(
      diagnostics.createReport(
        lab.actor,
        clinic.organizationId,
        { serviceOrderIds: [order.id], code: concept('Electrolytes'), results: [result] },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await diagnostics.transitionSpecimen(
      lab.actor,
      clinic.organizationId,
      specimen.id,
      { expectedVersion: 0, action: 'receive' },
      key(),
    );
    const report = await diagnostics.createReport(
      lab.actor,
      clinic.organizationId,
      {
        serviceOrderIds: [order.id],
        code: concept('Electrolytes'),
        results: [result],
        conclusion: 'Hyperkalaemia',
      },
      key(),
    );
    expect(await diagnosticQueries.patientReports(patientAccount.actor, patientId)).toHaveLength(0);
    await diagnostics.verifyReport(
      lab.actor,
      clinic.organizationId,
      report.id,
      { expectedVersion: 0, attestation: true },
      key(),
    );
    expect(await diagnosticQueries.patientReports(patientAccount.actor, patientId)).toHaveLength(1);

    const critical = (await ClinicalTask.findOne({
      'sourceRef.id': report.id,
      kind: 'CRITICAL_RESULT',
    }))!;
    expect(critical).toMatchObject({ priority: 'CRITICAL', status: 'OPEN' });
    await expect(
      tasks.transitionTask(
        doctor.actor,
        clinic.organizationId,
        String(critical._id),
        { expectedVersion: critical.version, action: 'cancel' },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const acknowledged = await tasks.transitionTask(
      doctor.actor,
      clinic.organizationId,
      String(critical._id),
      { expectedVersion: critical.version, action: 'acknowledge' },
      key(),
    );
    await tasks.transitionTask(
      doctor.actor,
      clinic.organizationId,
      String(critical._id),
      {
        expectedVersion: acknowledged.version,
        action: 'complete',
        outcome: 'Patient recalled for repeat test',
      },
      key(),
    );

    const verified = await diagnostics.getReportForLab(
      lab.actor,
      clinic.organizationId,
      report.id,
      { limit: 25 },
    );
    const observationId = String((verified.results[0] as { _id: string })._id);
    await diagnostics.amendReport(
      lab.actor,
      clinic.organizationId,
      report.id,
      {
        expectedVersion: (verified.report as { version: number }).version,
        reason: 'Haemolysed sample; corrected value',
        corrections: [
          {
            observationId,
            value: { type: 'QUANTITY', value: '4.8', unit: 'mmol/L' },
            interpretation: 'NORMAL',
          },
        ],
      },
      key(),
    );
    const revisions = await ClinicalRevision.find({ 'resource.id': observationId }).sort({
      revisionNumber: 1,
    });
    expect(revisions.map((row) => row.kind)).toEqual(['RECORDED', 'SIGNED', 'AMENDED']);
    expect(revisions[1]!.snapshot).toContain('6.9');
    expect(await ClinicalTask.countDocuments({ 'sourceRef.id': report.id })).toBe(2);
  });
});

describe('Membership notifications', () => {
  it('notifies an invited colleague through the outbox exactly once', async () => {
    const invitee = await account();
    const invitation = await memberships.inviteMember(
      owner.actor,
      clinic.organizationId,
      { userId: invitee.userId, role: 'receptionist', facilityScope: 'ALL', facilityIds: [] },
      key(),
    );
    await relayOutbox(500);
    await relayOutbox(500);
    expect(
      await Notification.countDocuments({
        userId: invitee.userId,
        templateCode: 'MEMBERSHIP_INVITED',
        channel: 'IN_APP',
      }),
    ).toBe(1);
    expect((await Membership.findById(invitation.id))!.status).toBe('INVITED');
    expect(await PatientRegistration.countDocuments({ patientId })).toBeGreaterThanOrEqual(1);
  });
});

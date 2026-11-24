import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import * as patients from '../../src/modules/patients/patient.service.js';
import * as encounters from '../../src/modules/clinical/encounter.service.js';
import * as records from '../../src/modules/clinical/record.service.js';
import * as locations from '../../src/modules/locations/location.service.js';
import { FacilityLocation } from '../../src/modules/locations/location.model.js';
import * as inpatient from '../../src/modules/inpatient/inpatient.service.js';
import { Admission, DischargePlan } from '../../src/modules/inpatient/inpatient.model.js';
import * as pharmacy from '../../src/modules/pharmacy/pharmacy.service.js';
import {
  StockBalance,
  StockBatch,
  PurchaseOrder,
} from '../../src/modules/pharmacy/pharmacy.model.js';
import { ChargeItem } from '../../src/modules/billing/billing.model.js';
import * as invoices from '../../src/modules/billing/invoice.service.js';
import { PrescriptionItem } from '../../src/modules/clinical/clinical.model.js';
import * as documents from '../../src/modules/documents/document.service.js';
import { ClinicalDocument } from '../../src/modules/documents/document.model.js';
import {
  setPrivateStore,
  type PrivateObjectStore,
} from '../../src/modules/documents/private-storage.js';
import { setMalwareScanner } from '../../src/modules/documents/scanner.js';
import * as commerce from '../../src/modules/commerce/subscription.service.js';
import { PatientRegistration } from '../../src/modules/patients/patient.model.js';
import {
  account,
  key,
  platformAdmin,
  professional,
  provider,
  staff,
  startDatabase,
  stopDatabase,
  verifiedDoctor,
  type Identity,
} from './support.js';

const concept = (text: string) => ({ text, codings: [] });
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(256, 32)]);

class MemoryStore implements PrivateObjectStore {
  readonly provider = 'memory';
  readonly bucket = 'private-test';
  objects = new Map<string, { body: Buffer; type: string }>();
  async presignUpload(key: string) {
    return `https://uploads.invalid/${encodeURIComponent(key)}`;
  }
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { sizeBytes: object.body.length, contentType: object.type } : undefined;
  }
  async read(key: string) {
    return this.objects.get(key)!.body;
  }
  async copy(source: string, target: string) {
    this.objects.set(target, this.objects.get(source)!);
    return {};
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  async presignDownload(key: string) {
    return `https://downloads.invalid/${encodeURIComponent(key)}?expires=60`;
  }
}
const store = new MemoryStore();

let owner: Identity;
let reviewer: Identity;
let doctor: Identity;
let hospital: { organizationId: string; facilityId: string };

beforeAll(async () => {
  await startDatabase();
  setPrivateStore(store);
  setMalwareScanner({
    async scan(content: Buffer) {
      return content.includes(Buffer.from('EICAR'))
        ? { status: 'INFECTED', signature: 'Test-Signature', engine: 'test', version: '1' }
        : { status: 'CLEAN', engine: 'test', version: '1' };
    },
  });
  owner = await account();
  reviewer = await platformAdmin();
  doctor = await account();
  hospital = await provider(owner, reviewer, 'HOSPITAL');
  await verifiedDoctor(doctor, reviewer, owner, hospital);
});
afterAll(stopDatabase);

async function registeredPatient(sex: 'FEMALE' | 'MALE' = 'FEMALE') {
  const identity = await account();
  const profile = await patients.createPatient(
    identity.actor,
    {
      kind: 'SELF',
      profile: {
        name: { display: 'Inpatient Example' },
        birthDate: '1985-03-03',
        administrativeSex: sex,
        preferredLanguage: 'en',
        addresses: [],
        contacts: [],
        emergencyContacts: [],
      },
    },
    key(),
  );
  await patients.registerSelfAtProvider(
    identity.actor,
    profile.id,
    { organizationId: hospital.organizationId, facilityId: hospital.facilityId },
    key(),
  );
  return { identity, patientId: profile.id };
}

async function signedPrescription(
  patientId: string,
  quantity: number,
  drugId?: string,
  name = 'Amoxicillin',
) {
  const encounter = await encounters.startEncounter(
    doctor.actor,
    hospital.organizationId,
    {
      patientId,
      facilityId: hospital.facilityId,
      type: concept('Consultation'),
      mode: 'IN_PERSON',
      chiefComplaint: 'Infection',
    },
    key(),
  );
  const draft = await records.createPrescription(
    doctor.actor,
    hospital.organizationId,
    encounter.id,
    {
      validDays: 30,
      items: [
        {
          drugId,
          medication: { name, form: 'Capsule', strength: '500 mg' },
          dosage: [
            {
              route: 'Oral',
              frequencyPerDay: 3,
              timesOfDay: [],
              asNeeded: false,
              durationDays: 5,
              instructions: 'Three times daily',
            },
          ],
          quantity: { value: quantity, unit: 'capsule' },
          refillsAllowed: 0,
          substitutionAllowed: false,
        },
      ],
    },
    key(),
  );
  await records.signRecord(
    doctor.actor,
    hospital.organizationId,
    'prescription',
    draft.id,
    { expectedVersion: 0, attestation: true },
    key(),
  );
  const item = (await PrescriptionItem.findOne({ prescriptionId: draft.id }))!;
  return { encounterId: encounter.id, prescriptionId: draft.id, itemId: String(item._id) };
}

describe('Pharmacy stock and dispensing', () => {
  it('quarantines receipts, requires release, guards quantities, allergies and the last unit', async () => {
    const pharmacist = await account();
    await professional(pharmacist, 'PHARMACIST');
    await staff(owner, pharmacist, hospital.organizationId, hospital.facilityId, 'pharmacist');
    const drug = await pharmacy.addDrug(
      reviewer.actor,
      {
        system: 'local-formulary',
        code: 'AMOX500',
        release: '2026-11',
        genericName: 'Amoxicillin',
        form: 'Capsule',
        strength: '500 mg',
        routes: ['Oral'],
        licenseReference: 'Synthetic test catalog',
      },
      key(),
    );
    const storeLocation = await locations.createLocation(
      owner.actor,
      hospital.organizationId,
      {
        facilityId: hospital.facilityId,
        code: 'PHARM-STORE',
        name: 'Main pharmacy store',
        kind: 'STORE',
        capabilities: [],
        isolationCapable: false,
      },
      key(),
    );
    const item = await pharmacy.createInventoryItem(
      pharmacist.actor,
      hospital.organizationId,
      {
        sku: 'AMOX-500-CAP',
        kind: 'DRUG',
        drugId: drug.id,
        name: 'Amoxicillin 500 mg capsule',
        stockUnit: 'capsule',
        reorderPoint: 5,
        salePriceMinor: 1_200,
        taxBasisPoints: 1_200,
      },
      key(),
    );
    const supplier = await pharmacy.createSupplier(
      pharmacist.actor,
      hospital.organizationId,
      { code: 'SUP-1', legalName: 'Synthetic Distributor', contacts: [], licenseIdentifiers: [] },
      key(),
    );
    const po = await pharmacy.createPurchaseOrder(
      pharmacist.actor,
      hospital.organizationId,
      {
        supplierId: supplier.id,
        destinationId: storeLocation.id,
        lines: [{ itemId: item.id, quantity: 20, unitCostMinor: 800 }],
      },
      key(),
    );
    await expect(
      pharmacy.actOnPurchaseOrder(
        pharmacist.actor,
        hospital.organizationId,
        po.id,
        { expectedVersion: 0, action: 'approve' },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const approved = await pharmacy.actOnPurchaseOrder(
      owner.actor,
      hospital.organizationId,
      po.id,
      { expectedVersion: 0, action: 'approve' },
      key(),
    );
    const ordered = await pharmacy.actOnPurchaseOrder(
      pharmacist.actor,
      hospital.organizationId,
      po.id,
      { expectedVersion: approved.version, action: 'order' },
      key(),
    );
    const expiresOn = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
    await expect(
      pharmacy.receiveGoods(
        pharmacist.actor,
        hospital.organizationId,
        po.id,
        {
          expectedVersion: ordered.version,
          lines: [
            {
              purchaseLine: 1,
              batchNumber: 'B1',
              manufacturer: 'Maker',
              expiresOn,
              accepted: 25,
              rejected: 0,
            },
          ],
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'OVER_RECEIPT' });
    await pharmacy.receiveGoods(
      pharmacist.actor,
      hospital.organizationId,
      po.id,
      {
        expectedVersion: ordered.version,
        lines: [
          {
            purchaseLine: 1,
            batchNumber: 'B1',
            manufacturer: 'Maker',
            expiresOn,
            accepted: 18,
            rejected: 2,
          },
        ],
      },
      key(),
    );
    expect((await PurchaseOrder.findById(po.id))!.status).toBe('RECEIVED');
    const batch = (await StockBatch.findOne({ batchNumber: 'B1' }))!;
    expect((await StockBalance.findOne({ batchId: batch._id }))!).toMatchObject({
      onHand: 0,
      quarantined: 18,
    });

    const { patientId, identity } = await registeredPatient();
    const rx = await signedPrescription(patientId, 15, drug.id);
    const line = {
      prescriptionItemId: rx.itemId,
      inventoryItemId: item.id,
      batchId: String(batch._id),
      locationId: storeLocation.id,
      quantity: 10,
    };
    await expect(
      pharmacy.dispense(
        pharmacist.actor,
        hospital.organizationId,
        {
          prescriptionId: rx.prescriptionId,
          pharmacyFacilityId: hospital.facilityId,
          lines: [line],
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'BATCH_UNAVAILABLE' });
    await pharmacy.actOnBatch(
      pharmacist.actor,
      hospital.organizationId,
      String(batch._id),
      { expectedVersion: batch.version, action: 'release', reason: 'Quality inspection passed' },
      key(),
    );
    expect((await StockBalance.findOne({ batchId: batch._id }))!).toMatchObject({
      onHand: 18,
      quarantined: 0,
    });

    await records.recordFact(
      doctor.actor,
      hospital.organizationId,
      patientId,
      'allergy',
      {
        source: 'PATIENT',
        substance: concept('Amoxicillin'),
        category: 'DRUG',
        clinicalStatus: 'ACTIVE',
        verificationStatus: 'UNCONFIRMED',
        criticality: 'UNABLE_TO_ASSESS',
        reactions: [],
      },
      key(),
    );
    await expect(
      pharmacy.dispense(
        pharmacist.actor,
        hospital.organizationId,
        {
          prescriptionId: rx.prescriptionId,
          pharmacyFacilityId: hospital.facilityId,
          lines: [line],
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'ALLERGY_REVIEW_REQUIRED' });
    await expect(
      pharmacy.dispense(
        pharmacist.actor,
        hospital.organizationId,
        {
          prescriptionId: rx.prescriptionId,
          pharmacyFacilityId: hospital.facilityId,
          lines: [{ ...line, quantity: 16 }],
          allergyOverrideReason: 'Prescriber confirmed tolerance',
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'QUANTITY_EXCEEDED' });
    const first = await pharmacy.dispense(
      pharmacist.actor,
      hospital.organizationId,
      {
        prescriptionId: rx.prescriptionId,
        pharmacyFacilityId: hospital.facilityId,
        lines: [line],
        allergyOverrideReason: 'Prescriber confirmed tolerance',
      },
      key(),
    );
    expect((await StockBalance.findOne({ batchId: batch._id }))!.onHand).toBe(8);

    // Two prescriptions race for the last eight units; exactly one dispense may succeed.
    const other = await registeredPatient();
    const rxA = await signedPrescription(other.patientId, 8, drug.id);
    const rxB = await signedPrescription(other.patientId, 8, drug.id);
    const race = await Promise.allSettled(
      [rxA, rxB].map((rxn) =>
        pharmacy.dispense(
          pharmacist.actor,
          hospital.organizationId,
          {
            prescriptionId: rxn.prescriptionId,
            pharmacyFacilityId: hospital.facilityId,
            lines: [{ ...line, prescriptionItemId: rxn.itemId, quantity: 8 }],
          },
          key(),
        ),
      ),
    );
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await StockBalance.findOne({ batchId: batch._id }))!.onHand).toBe(0);

    await pharmacy.returnDispense(
      pharmacist.actor,
      hospital.organizationId,
      first.id,
      {
        expectedVersion: 0,
        lines: [{ line: 1, quantity: 2 }],
        reason: 'Patient returned unopened strip',
      },
      key(),
    );
    expect((await StockBalance.findOne({ batchId: batch._id }))!).toMatchObject({
      onHand: 0,
      quarantined: 2,
    });

    const registration = (await PatientRegistration.findOne({
      organizationId: hospital.organizationId,
      patientId,
    }))!;
    const charges = await ChargeItem.find({
      patientRegistrationId: registration._id,
      status: 'UNBILLED',
    });
    expect(charges).toHaveLength(1);
    const invoice = await invoices.createInvoice(
      owner.actor,
      hospital.organizationId,
      {
        patientRegistrationId: String(registration._id),
        chargeItemIds: [String(charges[0]!._id)],
        lines: [],
        dueInDays: 7,
      },
      key(),
    );
    await invoices.issueInvoice(owner.actor, hospital.organizationId, invoice.id, 0, key());
    expect((await ChargeItem.findById(charges[0]!._id))!.status).toBe('BILLED');
    expect(
      (await invoices.getInvoice(owner.actor, hospital.organizationId, invoice.id)).totalMinor,
    ).toBe(13_440);
    expect(identity).toBeDefined();
  });
});

describe('Admission, beds and discharge', () => {
  it('prevents double occupancy, transfers atomically and separates clinical discharge from departure', async () => {
    const nurse = await account();
    await professional(nurse, 'NURSE');
    await staff(owner, nurse, hospital.organizationId, hospital.facilityId, 'nurse');
    const ward = await locations.createLocation(
      owner.actor,
      hospital.organizationId,
      {
        facilityId: hospital.facilityId,
        code: 'WARD-A',
        name: 'Ward A',
        kind: 'WARD',
        capabilities: [],
        isolationCapable: false,
      },
      key(),
    );
    const bed1 = await locations.createLocation(
      owner.actor,
      hospital.organizationId,
      {
        facilityId: hospital.facilityId,
        parentId: ward.id,
        code: 'A-01',
        name: 'Bed A-01',
        kind: 'BED',
        capabilities: [],
        isolationCapable: false,
      },
      key(),
    );
    const bed2 = await locations.createLocation(
      owner.actor,
      hospital.organizationId,
      {
        facilityId: hospital.facilityId,
        parentId: ward.id,
        code: 'A-02',
        name: 'Bed A-02',
        kind: 'BED',
        capabilities: [],
        isolationCapable: false,
      },
      key(),
    );
    await expect(
      locations.createLocation(
        owner.actor,
        hospital.organizationId,
        {
          facilityId: hospital.facilityId,
          parentId: bed1.id,
          code: 'BAD',
          name: 'Bad',
          kind: 'BED',
          capabilities: [],
          isolationCapable: false,
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    const first = await registeredPatient();
    const second = await registeredPatient('MALE');
    const admissionA = await inpatient.requestAdmission(
      doctor.actor,
      hospital.organizationId,
      {
        patientId: first.patientId,
        facilityId: hospital.facilityId,
        type: 'EMERGENCY',
        reason: concept('Pneumonia'),
      },
      key(),
    );
    const admissionB = await inpatient.requestAdmission(
      doctor.actor,
      hospital.organizationId,
      {
        patientId: second.patientId,
        facilityId: hospital.facilityId,
        type: 'ELECTIVE',
        reason: concept('Observation'),
      },
      key(),
    );
    const race = await Promise.allSettled([
      inpatient.admit(
        owner.actor,
        hospital.organizationId,
        admissionA.id,
        { expectedVersion: 0, bedId: bed1.id, reason: 'Admission' },
        key(),
      ),
      inpatient.admit(
        owner.actor,
        hospital.organizationId,
        admissionB.id,
        { expectedVersion: 0, bedId: bed1.id, reason: 'Admission' },
        key(),
      ),
    ]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = race[0]!.status === 'fulfilled' ? admissionA : admissionB;
    const winnerPatient = winner === admissionA ? first : second;
    expect((await FacilityLocation.findById(bed1.id))!.operationalStatus).toBe('OCCUPIED');

    const current = (await Admission.findById(winner.id))!;
    await inpatient.transferBed(
      owner.actor,
      hospital.organizationId,
      winner.id,
      {
        expectedVersion: current.version,
        targetBedId: bed2.id,
        reason: 'Move closer to nursing station',
      },
      key(),
    );
    expect((await FacilityLocation.findById(bed1.id))!.operationalStatus).toBe('CLEANING');
    expect((await FacilityLocation.findById(bed2.id))!.operationalStatus).toBe('OCCUPIED');

    await expect(
      inpatient.recordFluid(
        nurse.actor,
        hospital.organizationId,
        winner.id,
        {
          direction: 'INTAKE',
          type: 'IV saline',
          amountMl: 500,
          measuredAt: new Date().toISOString(),
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await encounters.assignCareTeam(
      doctor.actor,
      hospital.organizationId,
      winnerPatient.patientId,
      { userId: nurse.userId, roleCode: 'NURSING' },
      key(),
    );
    await inpatient.recordFluid(
      nurse.actor,
      hospital.organizationId,
      winner.id,
      {
        direction: 'INTAKE',
        type: 'IV saline',
        amountMl: 500,
        measuredAt: new Date().toISOString(),
      },
      key(),
    );
    await inpatient.recordFluid(
      nurse.actor,
      hospital.organizationId,
      winner.id,
      { direction: 'OUTPUT', type: 'Urine', amountMl: 300, measuredAt: new Date().toISOString() },
      key(),
    );
    await inpatient.recordInpatientObservation(
      nurse.actor,
      hospital.organizationId,
      winner.id,
      {
        category: 'VITAL_SIGNS',
        code: concept('Pulse rate'),
        value: { type: 'QUANTITY', value: '96', unit: '/min' },
        effectiveAt: new Date().toISOString(),
        status: 'FINAL',
      },
      key(),
    );
    const rx = await signedPrescription(winnerPatient.patientId, 15, undefined, 'Ceftriaxone');
    await inpatient.recordAdministration(
      nurse.actor,
      hospital.organizationId,
      winner.id,
      {
        prescriptionItemId: rx.itemId,
        status: 'GIVEN',
        administeredAt: new Date().toISOString(),
        doseValue: '1',
        doseUnit: 'g',
        route: 'IV',
      },
      key(),
    );
    const refused = await inpatient.recordAdministration(
      nurse.actor,
      hospital.organizationId,
      winner.id,
      { prescriptionItemId: rx.itemId, status: 'REFUSED', reason: 'Patient declined the dose' },
      key(),
    );
    await inpatient.correctAdministration(
      nurse.actor,
      hospital.organizationId,
      refused.id,
      { reason: 'Recorded against the wrong patient' },
      key(),
    );
    const chart = await inpatient.nursingChart(nurse.actor, hospital.organizationId, winner.id);
    expect(chart.fluidBalance24h).toEqual({ intakeMl: 500, outputMl: 300, netMl: 200 });
    expect(chart.administrations.map((row) => row.status).sort()).toEqual([
      'ENTERED_IN_ERROR',
      'GIVEN',
      'REFUSED',
    ]);

    const plan = await inpatient.createDischargePlan(
      doctor.actor,
      hospital.organizationId,
      winner.id,
      { plannedAt: new Date().toISOString(), checklist: [] },
      key(),
    );
    const planned = (await Admission.findById(winner.id))!;
    await expect(
      inpatient.clinicalDischarge(
        doctor.actor,
        hospital.organizationId,
        winner.id,
        { expectedVersion: planned.version, disposition: 'Home' },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'DISCHARGE_NOT_READY' });
    const summary = await records.createNote(
      doctor.actor,
      hospital.organizationId,
      rx.encounterId,
      {
        noteType: 'DISCHARGE_SUMMARY',
        sections: { assessment: 'Recovered', plan: 'Oral antibiotics for five days' },
        reviewState: { allergies: 'REVIEWED', medications: 'REVIEWED' },
      },
      key(),
    );
    await expect(
      inpatient.updateChecklist(
        doctor.actor,
        hospital.organizationId,
        plan.id,
        {
          expectedVersion: 0,
          code: 'DISCHARGE_SUMMARY_SIGNED',
          status: 'DONE',
          summaryNoteId: summary.id,
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_RECORD' });
    await records.signRecord(
      doctor.actor,
      hospital.organizationId,
      'clinicalNote',
      summary.id,
      { expectedVersion: 0, attestation: true },
      key(),
    );
    let version = 0;
    for (const code of ['DISCHARGE_SUMMARY_SIGNED', 'MEDICINES_RECONCILED', 'PATIENT_EDUCATION'])
      version = (
        await inpatient.updateChecklist(
          doctor.actor,
          hospital.organizationId,
          plan.id,
          { expectedVersion: version, code, status: 'DONE', summaryNoteId: summary.id },
          key(),
        )
      ).version;
    expect((await DischargePlan.findById(plan.id))!.status).toBe('READY');
    const discharged = await inpatient.clinicalDischarge(
      doctor.actor,
      hospital.organizationId,
      winner.id,
      { expectedVersion: planned.version, disposition: 'Home' },
      key(),
    );
    expect((await FacilityLocation.findById(bed2.id))!.operationalStatus).toBe('OCCUPIED');
    await inpatient.depart(
      owner.actor,
      hospital.organizationId,
      winner.id,
      { expectedVersion: discharged.version },
      key(),
    );
    expect((await FacilityLocation.findById(bed2.id))!.operationalStatus).toBe('CLEANING');
    expect((await Admission.findById(winner.id))!).toMatchObject({
      status: 'DEPARTED',
      financialStatus: 'OPEN',
    });
  });
});

describe('Private documents', () => {
  it('verifies uploads server-side, scans before availability and audits short-lived access', async () => {
    const { identity, patientId } = await registeredPatient();
    const intent = await documents.createUploadIntent(
      identity.actor,
      {
        custody: { kind: 'PATIENT', patientId },
        category: 'CLINICAL_REPORT',
        title: 'Outside lab report',
        originalName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length,
      },
      key(),
    );
    expect('upload' in intent && intent.upload.url).toContain('uploads.invalid');
    await expect(
      documents.completeUpload(identity.actor, intent.id, { expectedVersion: 0 }, key()),
    ).rejects.toMatchObject({ code: 'UPLOAD_MISSING' });
    const pendingKey = (await ClinicalDocument.findById(intent.id))!.pendingUpload!.key;
    store.objects.set(pendingKey, { body: PDF, type: 'application/pdf' });
    await documents.completeUpload(identity.actor, intent.id, { expectedVersion: 0 }, key());
    await expect(
      documents.requestDocumentAccess(identity.actor, intent.id, { purpose: 'PATIENT_ACCESS' }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_AVAILABLE' });
    await documents.scanQuarantinedDocuments();
    const available = (await ClinicalDocument.findById(intent.id))!;
    expect(available.status).toBe('AVAILABLE');
    expect(store.objects.has(pendingKey)).toBe(false);
    const access = await documents.requestDocumentAccess(identity.actor, intent.id, {
      purpose: 'PATIENT_ACCESS',
    });
    expect(access.url).toContain('expires=60');
    expect(access.sha256).toMatch(/^[a-f0-9]{64}$/);
    const stranger = await account();
    await expect(
      documents.requestDocumentAccess(stranger.actor, intent.id, { purpose: 'PATIENT_ACCESS' }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const forged = await documents.createUploadIntent(
      identity.actor,
      {
        custody: { kind: 'PATIENT', patientId },
        category: 'OTHER',
        title: 'Not really a PDF',
        originalName: 'fake.pdf',
        mimeType: 'application/pdf',
        sizeBytes: Buffer.byteLength('MZ-executable'),
      },
      key(),
    );
    store.objects.set((await ClinicalDocument.findById(forged.id))!.pendingUpload!.key, {
      body: Buffer.from('MZ-executable'),
      type: 'application/pdf',
    });
    await documents.completeUpload(identity.actor, forged.id, { expectedVersion: 0 }, key());
    const infected = await documents.createUploadIntent(
      identity.actor,
      {
        custody: { kind: 'PATIENT', patientId },
        category: 'OTHER',
        title: 'Infected',
        originalName: 'virus.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length + 5,
      },
      key(),
    );
    store.objects.set((await ClinicalDocument.findById(infected.id))!.pendingUpload!.key, {
      body: Buffer.concat([PDF, Buffer.from('EICAR')]),
      type: 'application/pdf',
    });
    await documents.completeUpload(identity.actor, infected.id, { expectedVersion: 0 }, key());
    await documents.scanQuarantinedDocuments();
    expect((await ClinicalDocument.findById(forged.id))!).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'CONTENT_TYPE_MISMATCH',
    });
    expect((await ClinicalDocument.findById(infected.id))!).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'MALWARE_DETECTED',
    });
  });
});

describe('Provider subscriptions', () => {
  it('keeps one current subscription and moves an unpaid period through grace to suspension', async () => {
    const plan = await commerce.publishPlan(
      reviewer.actor,
      {
        code: 'CLINIC_PRO',
        name: 'Clinic Pro',
        period: 'MONTH',
        priceMinor: 199_900,
        trialDays: 0,
        entitlements: [{ feature: 'doctor-seats', limit: 10 }],
        effectiveFrom: new Date(Date.now() - 1000).toISOString(),
      },
      key(),
    );
    const subscription = await commerce.subscribe(
      owner.actor,
      hospital.organizationId,
      { planId: plan.id, renewalMode: 'AUTO' },
      key(),
    );
    await expect(
      commerce.subscribe(
        owner.actor,
        hospital.organizationId,
        { planId: plan.id, renewalMode: 'AUTO' },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const current = await commerce.currentSubscription(owner.actor, hospital.organizationId);
    expect(current.subscription).toMatchObject({ status: 'PAST_DUE' });
    expect(current.entitlements).toEqual([{ feature: 'doctor-seats', limit: 10 }]);
    await commerce.Subscription.updateOne(
      { _id: subscription.id },
      { $set: { graceEndsAt: new Date(Date.now() - 1000) } },
    );
    await commerce.renewSubscriptions();
    expect((await commerce.Subscription.findById(subscription.id))!.status).toBe('SUSPENDED');
    expect(await commerce.entitlements(hospital.organizationId)).toEqual([]);
  });
});

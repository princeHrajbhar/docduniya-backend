/**
 * Regression tests for the defects reproduced in docs/reviews/implementation-verification-2026-11-24.md
 * (R1–R8 and the walk-in self-assignment weakness). Each test states the attack and the expected
 * refusal, then proves the legitimate path still works.
 */
import { createHash } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { stamp } from '../../src/shared/persistence/schema.js';
import { transaction } from '../../src/shared/application/command.js';
import * as documents from '../../src/modules/documents/document.service.js';
import * as documentDto from '../../src/modules/documents/document.validation.js';
import { ClinicalDocument, DocumentVersion } from '../../src/modules/documents/document.model.js';
import {
  setPrivateStore,
  type PrivateObjectStore,
} from '../../src/modules/documents/private-storage.js';
import { setMalwareScanner } from '../../src/modules/documents/scanner.js';
import * as patients from '../../src/modules/patients/patient.service.js';
import { PatientRelationship } from '../../src/modules/patients/patient.model.js';
import * as encounters from '../../src/modules/clinical/encounter.service.js';
import * as clinicalDto from '../../src/modules/clinical/clinical.validation.js';
import * as queries from '../../src/modules/clinical/clinical-query.service.js';
import * as records from '../../src/modules/clinical/record.service.js';
import { PrescriptionItem } from '../../src/modules/clinical/clinical.model.js';
import * as privacy from '../../src/modules/privacy/privacy.service.js';
import * as privacyDto from '../../src/modules/privacy/privacy.validation.js';
import * as organizations from '../../src/modules/organizations/organization.service.js';
import * as organizationDto from '../../src/modules/organizations/organization.validation.js';
import { MerchantAccount, PaymentIntent } from '../../src/modules/billing/billing.model.js';
import * as payments from '../../src/modules/payments/payment.service.js';
import {
  setPaymentGateway,
  type GatewayOrder,
  type PaymentGateway,
} from '../../src/modules/payments/gateway.js';
import { createLocation } from '../../src/modules/locations/location.service.js';
import * as pharmacy from '../../src/modules/pharmacy/pharmacy.service.js';
import * as pharmacyDto from '../../src/modules/pharmacy/pharmacy.validation.js';
import {
  InventoryItem,
  StockBalance,
  StockBatch,
} from '../../src/modules/pharmacy/pharmacy.model.js';
import * as inpatient from '../../src/modules/inpatient/inpatient.service.js';
import * as inpatientDto from '../../src/modules/inpatient/inpatient.validation.js';
import { Doctor, Practitioner } from '../../src/modules/practitioners/practitioner.model.js';
import { restrictDoctor } from '../../src/modules/providers/verification.service.js';
import * as appointments from '../../src/modules/appointments/appointment.service.js';
import { Appointment } from '../../src/modules/appointments/appointment.model.js';
import * as credentials from '../../src/modules/practitioners/credential.service.js';
import { ProfessionalCredentialReview } from '../../src/modules/practitioners/credential.model.js';
import {
  account,
  address,
  bookableOffering,
  key,
  patient,
  platformAdmin,
  professional,
  provider,
  slot,
  staff,
  startDatabase,
  stopDatabase,
  verifiedDoctor,
  walkIn,
  type Identity,
} from './support.js';

const PDF = (label: string) => Buffer.from(`%PDF-1.7\n${label.padEnd(64, '.')}`);
const concept = (text: string) => ({ text, codings: [] });

/** In-memory private store; `onScan` lets a test mutate the upload key mid-scan. */
class MemoryStore implements PrivateObjectStore {
  readonly provider = 'memory';
  readonly bucket = 'regression';
  objects = new Map<string, Buffer>();
  lastUploadKey = '';
  async presignUpload(objectKey: string) {
    this.lastUploadKey = objectKey;
    return 'https://upload.invalid';
  }
  async head(objectKey: string) {
    const body = this.objects.get(objectKey);
    return body ? { sizeBytes: body.length, contentType: 'application/pdf' } : undefined;
  }
  async read(objectKey: string) {
    return Buffer.from(this.objects.get(objectKey)!);
  }
  async putImmutable(objectKey: string, content: Buffer) {
    if (this.objects.has(objectKey)) throw new Error('Immutable key exists');
    this.objects.set(objectKey, Buffer.from(content));
    return { versionId: 'v1' };
  }
  async remove(objectKey: string) {
    this.objects.delete(objectKey);
  }
  async presignDownload() {
    return 'https://download.invalid';
  }
}

class CountingGateway implements Partial<PaymentGateway> {
  created = 0;
  orders = new Map<string, GatewayOrder>();
  async createOrder(
    _credentials: unknown,
    input: { amountMinor: number; currency: string; receipt: string },
  ) {
    this.created += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const order = { id: `order_${this.created}`, ...input };
    this.orders.set(input.receipt, order);
    return order;
  }
  async findOrderByReceipt(_credentials: unknown, receipt: string) {
    return this.orders.get(receipt);
  }
}

const store = new MemoryStore();
let owner: Identity;
let reviewer: Identity;
let doctor: Identity;
let person: Identity;
let clinic: { organizationId: string; facilityId: string };
let branchB: string;
let patientId: string;
let affiliationId: string;

async function upload(
  actor: Identity,
  custody: Record<string, unknown>,
  body: Buffer,
  category = 'CLINICAL_REPORT',
) {
  const intent = await documents.createUploadIntent(
    actor.actor,
    documentDto.uploadIntentInput.parse({
      custody,
      category,
      title: 'Regression document',
      originalName: 'regression.pdf',
      mimeType: 'application/pdf',
      sizeBytes: body.length,
    }),
    key(),
  );
  store.objects.set(store.lastUploadKey, body);
  await documents.completeUpload(actor.actor, intent.id, { expectedVersion: 0 }, key());
  await documents.scanQuarantinedDocuments(5);
  return intent.id;
}

async function encounterAt(clinician: Identity, facilityId: string, complaint: string) {
  return encounters.startEncounter(
    clinician.actor,
    clinic.organizationId,
    clinicalDto.encounterInput.parse({
      patientId,
      facilityId,
      queueEntryId: await walkIn(
        owner,
        { organizationId: clinic.organizationId, facilityId },
        patientId,
      ),
      type: concept('Consultation'),
      chiefComplaint: complaint,
    }),
    key(),
  );
}

beforeAll(async () => {
  await startDatabase();
  setPrivateStore(store);
  setMalwareScanner({
    async scan() {
      return { status: 'CLEAN' as const, engine: 'regression', version: '1' };
    },
  });
  owner = await account();
  reviewer = await platformAdmin();
  clinic = await provider(owner, reviewer);
  doctor = await account();
  affiliationId = (await verifiedDoctor(doctor, reviewer, owner, clinic)).affiliationId;
  person = await account();
  patientId = (await patient(person)).id;
  await patients.registerSelfAtProvider(person.actor, patientId, clinic, key());
  const second = await organizations.createFacility(
    owner.actor,
    clinic.organizationId,
    organizationDto.facilityInput.parse({
      name: 'Restricted second branch',
      code: 'BRANCH-B',
      kind: 'CLINIC',
      address,
    }),
    key(),
  );
  await organizations.changeFacilityState(
    owner.actor,
    clinic.organizationId,
    second.id,
    { expectedVersion: 0, status: 'ACTIVE', reason: 'Open the synthetic second branch' },
    key(),
  );
  branchB = second.id;
});
afterAll(stopDatabase);

describe('Verification regressions', () => {
  it('R1: promotes the exact scanned bytes even if the upload key is replaced mid-scan', async () => {
    const clean = PDF('SCANNED CLEAN BYTES');
    const replacement = PDF('UNSCANNED REPLACEMENT');
    setMalwareScanner({
      async scan() {
        store.objects.set(store.lastUploadKey, replacement);
        return { status: 'CLEAN' as const, engine: 'regression', version: '1' };
      },
    });
    const id = await upload(person, { kind: 'USER' }, clean, 'CREDENTIAL');
    setMalwareScanner({
      async scan() {
        return { status: 'CLEAN' as const, engine: 'regression', version: '1' };
      },
    });
    const document = (await ClinicalDocument.findById(id))!;
    expect(document.status).toBe('AVAILABLE');
    const version = (await DocumentVersion.findById(document.currentVersionId))!;
    const available = store.objects.get(version.file.key)!;
    expect(available.equals(clean)).toBe(true);
    expect(createHash('sha256').update(available).digest('hex')).toBe(version.file.sha256);
  });

  it('R2: demographic representatives cannot read medical records or authorize sharing', async () => {
    const representative = await account();
    const relation = await PatientRelationship.create({
      ...stamp(owner.userId),
      patientId,
      relatedUserId: representative.userId,
      relationship: 'CAREGIVER',
      allowedActions: ['profile.read', 'profile.update'],
      authorityReference: 'Synthetic demographics-only authorization',
      status: 'ACTIVE',
      validFrom: new Date(Date.now() - 1000),
      validUntil: new Date(Date.now() + 86400_000),
    });
    await expect(queries.patientRecords(representative.actor, patientId)).rejects.toMatchObject({
      statusCode: 404,
    });
    const sharing = privacyDto.sharingConsentInput.parse({
      recipientOrganizationId: clinic.organizationId,
      purposes: ['TREATMENT'],
      resourceTypes: ['clinicalNotes'],
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    await expect(
      privacy.grantRecordSharing(representative.actor, patientId, sharing, key()),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(privacy.exportPatientData(representative.actor, patientId)).rejects.toMatchObject({
      statusCode: 404,
    });
    // Explicitly reviewed medical authority is honoured.
    relation.allowedActions = ['profile.read', 'medical.read'];
    await relation.save();
    await expect(queries.patientRecords(representative.actor, patientId)).resolves.toBeTruthy();
  });

  it('walk-in: an unrelated clinician cannot self-authorize chart access by opening an encounter', async () => {
    const outsider = await account();
    await professional(outsider, 'NURSE');
    await staff(owner, outsider, clinic.organizationId, clinic.facilityId, 'nurse');
    await expect(
      encounters.startEncounter(
        outsider.actor,
        clinic.organizationId,
        clinicalDto.encounterInput.parse({
          patientId,
          facilityId: clinic.facilityId,
          type: concept('Self-assigned encounter'),
          chiefComplaint: 'No arrival or referral',
        }),
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ARRIVAL_REQUIRED' });
    await expect(
      queries.clinicalSummary(outsider.actor, clinic.organizationId, patientId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('R3: branch-restricted clinicians see only their branch in summaries and timelines', async () => {
    const own = await encounterAt(doctor, clinic.facilityId, 'Branch A complaint');
    const nurse = await account();
    await professional(nurse, 'NURSE');
    await staff(owner, nurse, clinic.organizationId, branchB, 'nurse');
    const restricted = await encounterAt(nurse, branchB, 'Secret from branch B');
    await expect(
      encounters.getEncounter(doctor.actor, clinic.organizationId, restricted.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    const summary = await queries.clinicalSummary(doctor.actor, clinic.organizationId, patientId);
    const ids = summary.encounters.map((row) => String(row.id));
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(restricted.id);
    const timeline = await queries.clinicalTimeline(doctor.actor, clinic.organizationId, patientId);
    expect(timeline.events.some((event) => String(event.record.id) === restricted.id)).toBe(false);
    const list = await encounters.listEncounters(doctor.actor, clinic.organizationId, {
      patientId,
      limit: 50,
    });
    expect(list.items.map((row) => row.id)).not.toContain(restricted.id);
    // The branch B nurse equally sees nothing of branch A.
    const nurseView = await queries.clinicalSummary(nurse.actor, clinic.organizationId, patientId);
    expect(nurseView.encounters.map((row) => String(row.id))).toEqual([restricted.id]);
  });

  it('R4: shared documents honour the consent period and reach only treating clinicians', async () => {
    const recipientOwner = await account();
    const recipient = await provider(recipientOwner, reviewer);
    const recipientDoctor = await account();
    await verifiedDoctor(recipientDoctor, reviewer, recipientOwner, recipient);
    await patients.registerSelfAtProvider(person.actor, patientId, recipient, key());
    await encounters.startEncounter(
      recipientDoctor.actor,
      recipient.organizationId,
      clinicalDto.encounterInput.parse({
        patientId,
        facilityId: recipient.facilityId,
        queueEntryId: await walkIn(recipientOwner, recipient, patientId),
        type: concept('Second opinion'),
        chiefComplaint: 'Review of outside report',
      }),
      key(),
    );
    const futureOnly = await privacy.grantRecordSharing(
      person.actor,
      patientId,
      privacyDto.sharingConsentInput.parse({
        recipientOrganizationId: recipient.organizationId,
        purposes: ['TREATMENT'],
        resourceTypes: ['documents'],
        recordPeriodStart: new Date(Date.now() + 86400_000).toISOString(),
        recordPeriodEnd: new Date(Date.now() + 2 * 86400_000).toISOString(),
        expiresAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
      }),
      key(),
    );
    const documentId = await upload(
      doctor,
      { kind: 'ORGANIZATION', organizationId: clinic.organizationId, patientId },
      PDF('OUTSIDE CONSENT PERIOD'),
    );
    await expect(
      documents.requestDocumentAccess(recipientDoctor.actor, documentId, { purpose: 'TREATMENT' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await privacy.withdrawConsent(
      person.actor,
      futureOnly.id,
      { expectedVersion: 0, reason: 'Replace with a current sharing period' },
      key(),
    );
    await privacy.grantRecordSharing(
      person.actor,
      patientId,
      privacyDto.sharingConsentInput.parse({
        recipientOrganizationId: recipient.organizationId,
        purposes: ['TREATMENT'],
        resourceTypes: ['documents'],
        expiresAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
      }),
      key(),
    );
    // An administrator of the recipient is never a clinical recipient.
    await expect(
      documents.requestDocumentAccess(recipientOwner.actor, documentId, { purpose: 'TREATMENT' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    // A purpose outside the consent is refused.
    await expect(
      documents.requestDocumentAccess(recipientDoctor.actor, documentId, { purpose: 'BILLING' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const access = await documents.requestDocumentAccess(recipientDoctor.actor, documentId, {
      purpose: 'TREATMENT',
    });
    expect(access.url).toBeTruthy();
  });

  it('R5 and R6: stock moves only at authorized branches; full supply keeps the order administrable', async () => {
    const pharmacist = await account();
    await professional(pharmacist, 'PHARMACIST');
    await staff(owner, pharmacist, clinic.organizationId, clinic.facilityId, 'pharmacist');
    const storeA = await createLocation(
      owner.actor,
      clinic.organizationId,
      {
        facilityId: clinic.facilityId,
        code: 'STORE-A',
        name: 'Branch A store',
        kind: 'STORE',
        capabilities: [],
        isolationCapable: false,
      },
      key(),
    );
    const storeB = await createLocation(
      owner.actor,
      clinic.organizationId,
      {
        facilityId: branchB,
        code: 'STORE-B',
        name: 'Branch B store',
        kind: 'STORE',
        capabilities: [],
        isolationCapable: false,
      },
      key(),
    );
    const item = await InventoryItem.create({
      ...stamp(owner.userId),
      organizationId: clinic.organizationId,
      sku: 'REG-1',
      kind: 'DRUG',
      name: 'Regression Medicine',
      stockUnit: 'tablet',
    });
    const batch = await StockBatch.create({
      ...stamp(owner.userId),
      organizationId: clinic.organizationId,
      itemId: item._id,
      batchNumber: 'REG-B1',
      manufacturer: 'Synthetic',
      expiresOn: '2030-01-01',
      status: 'RELEASED',
    });
    for (const location of [storeA, storeB])
      await transaction((session) =>
        pharmacy.moveStock(
          owner.actor,
          {
            organizationId: clinic.organizationId,
            itemId: item._id,
            batchId: batch._id,
            locationId: location.id,
            bucket: 'ON_HAND',
            quantityDelta: 2,
            reason: 'RECEIVE',
            source: { type: 'regression', id: location.id },
            operationKey: `regression-seed:${location.id}`,
          },
          session,
        ),
      );
    const encounter = await encounterAt(doctor, clinic.facilityId, 'Needs medicine');
    const rx = await records.createPrescription(
      doctor.actor,
      clinic.organizationId,
      encounter.id,
      clinicalDto.prescriptionInput.parse({
        validDays: 30,
        items: [
          {
            medication: { name: 'Regression Medicine', form: 'Tablet' },
            dosage: [{ route: 'Oral', instructions: 'One tablet twice daily' }],
            quantity: { value: 2, unit: 'tablet' },
            refillsAllowed: 0,
            substitutionAllowed: false,
          },
        ],
      }),
      key(),
    );
    await records.signRecord(
      doctor.actor,
      clinic.organizationId,
      'prescription',
      rx.id,
      { expectedVersion: 0, attestation: true },
      key(),
    );
    const prescriptionItem = (await PrescriptionItem.findOne({ prescriptionId: rx.id }))!;
    const line = (locationId: string) =>
      pharmacyDto.dispenseInput.parse({
        prescriptionId: rx.id,
        pharmacyFacilityId: clinic.facilityId,
        lines: [
          {
            prescriptionItemId: String(prescriptionItem._id),
            inventoryItemId: String(item._id),
            batchId: String(batch._id),
            locationId,
            quantity: 2,
          },
        ],
      });
    await expect(
      pharmacy.dispense(pharmacist.actor, clinic.organizationId, line(storeB.id), key()),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await StockBalance.findOne({ locationId: storeB.id }))!.onHand).toBe(2);
    await expect(
      pharmacy.stockBalances(pharmacist.actor, clinic.organizationId, {
        locationId: storeB.id,
        limit: 10,
      } as never),
    ).rejects.toMatchObject({ statusCode: 404 });

    await pharmacy.dispense(pharmacist.actor, clinic.organizationId, line(storeA.id), key());
    const supplied = (await PrescriptionItem.findById(prescriptionItem._id))!;
    expect(supplied.status).toBe('ACTIVE');
    expect(supplied.fulfillmentStatus).toBe('FULFILLED');

    const ward = await createLocation(
      owner.actor,
      clinic.organizationId,
      {
        facilityId: clinic.facilityId,
        code: 'REG-WARD',
        name: 'Regression ward',
        kind: 'WARD',
        capabilities: [],
        isolationCapable: false,
      },
      key(),
    );
    const bed = await createLocation(
      owner.actor,
      clinic.organizationId,
      {
        facilityId: clinic.facilityId,
        parentId: ward.id,
        code: 'REG-BED',
        name: 'Regression bed',
        kind: 'BED',
        capabilities: [],
        isolationCapable: false,
      },
      key(),
    );
    const admission = await inpatient.requestAdmission(
      doctor.actor,
      clinic.organizationId,
      inpatientDto.admissionInput.parse({
        patientId,
        facilityId: clinic.facilityId,
        type: 'ELECTIVE',
        reason: concept('Observation'),
      }),
      key(),
    );
    await inpatient.admit(
      owner.actor,
      clinic.organizationId,
      admission.id,
      { expectedVersion: 0, bedId: bed.id, reason: 'Synthetic admission' },
      key(),
    );
    const nurse = await account();
    const nurseProfile = await professional(nurse, 'NURSE');
    await staff(owner, nurse, clinic.organizationId, clinic.facilityId, 'nurse');
    await encounters.assignCareTeam(
      doctor.actor,
      clinic.organizationId,
      patientId,
      { userId: nurse.userId, roleCode: 'NURSING' },
      key(),
    );
    const dose = inpatientDto.administrationInput.parse({
      prescriptionItemId: String(prescriptionItem._id),
      status: 'GIVEN',
      administeredAt: new Date().toISOString(),
      doseValue: '1',
      doseUnit: 'tablet',
      route: 'Oral',
    });
    await expect(
      inpatient.recordAdministration(nurse.actor, clinic.organizationId, admission.id, dose, key()),
    ).resolves.toMatchObject({ id: expect.any(String) });

    // A suspended nurse credential removes the licensed privilege at once.
    const reviewId = (nurseProfile as { credentialReviewId: string }).credentialReviewId;
    const current = (await ProfessionalCredentialReview.findById(reviewId))!;
    await credentials.suspendCredential(
      reviewer.actor,
      reviewId,
      {
        expectedVersion: current.version,
        reason: 'Synthetic suspension of the nursing registration',
      },
      key(),
    );
    await expect(
      inpatient.recordAdministration(nurse.actor, clinic.organizationId, admission.id, dose, key()),
    ).rejects.toMatchObject({ statusCode: 403, code: 'CREDENTIAL_INVALID' });
  });

  it('R8: committed intents are prepared by the worker exactly once, including stale leases', async () => {
    process.env.RAZORPAY_KEY_SECRET_REGRESSION = 'synthetic-regression-secret';
    const gateway = new CountingGateway();
    setPaymentGateway(gateway as unknown as PaymentGateway);
    const merchant = await MerchantAccount.create({
      ...stamp(owner.userId),
      organizationId: clinic.organizationId,
      provider: 'RAZORPAY',
      label: 'Regression merchant',
      providerAccountId: 'rzp_test_regression',
      keySecretRef: 'env:RAZORPAY_KEY_SECRET_REGRESSION',
      webhookSecretRef: 'env:RAZORPAY_KEY_SECRET_REGRESSION',
      status: 'ACTIVE',
    });
    const crashed = await PaymentIntent.create({
      ...stamp(person.userId),
      organizationId: clinic.organizationId,
      merchantAccountId: merchant._id,
      patientId,
      amountMinor: 50_000,
      operationKey: 'regression-crash-before-prepare',
      status: 'CREATED',
    });
    // Two worker instances race; the persisted lease admits exactly one gateway call.
    const picked = await Promise.all([
      payments.retryPendingOrders(),
      payments.retryPendingOrders(),
    ]);
    expect(picked.reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(1);
    expect(gateway.created).toBe(1);
    expect((await PaymentIntent.findById(crashed._id))!.status).toBe('READY');

    // A worker that died holding the lease after the remote order was created: recovery finds
    // the order by receipt instead of creating a second one.
    const stale = await PaymentIntent.create({
      ...stamp(person.userId),
      organizationId: clinic.organizationId,
      merchantAccountId: merchant._id,
      patientId,
      amountMinor: 70_000,
      operationKey: 'regression-stale-lease',
      status: 'ORDER_PENDING',
      orderAttempts: 1,
      orderLeaseToken: 'dead-worker',
      orderLeaseUntil: new Date(Date.now() - 1000),
    });
    gateway.orders.set(String(stale._id), {
      id: 'order_remote_before_crash',
      amountMinor: 70_000,
      currency: 'INR',
    });
    await payments.retryPendingOrders();
    const recovered = (await PaymentIntent.findById(stale._id))!;
    expect(recovered.status).toBe('READY');
    expect(recovered.providerOrderId).toBe('order_remote_before_crash');
    expect(gateway.created).toBe(1);
  });

  it('R7: a suspended doctor cannot sign new clinical notes', async () => {
    const encounter = await encounterAt(doctor, clinic.facilityId, 'Before suspension');
    const offering = await bookableOffering(owner, clinic, affiliationId);
    const upcoming = await appointments.createHold(
      person.actor,
      {
        patientId,
        offeringId: offering.offeringId,
        offeringVersion: offering.version,
        priceId: offering.priceId,
        startAt: slot(6, 660),
      },
      key(),
    );
    const practitioner = (await Practitioner.findOne({ userId: doctor.userId }))!;
    const doctorRow = (await Doctor.findOne({ practitionerId: practitioner._id }))!;
    await restrictDoctor(
      reviewer.actor,
      String(doctorRow._id),
      {
        expectedVersion: doctorRow.version,
        status: 'SUSPENDED',
        reason: 'Synthetic credential suspension for regression',
      },
      key(),
    );
    const note = await records.createNote(
      doctor.actor,
      clinic.organizationId,
      encounter.id,
      clinicalDto.noteInput.parse({
        noteType: 'CONSULTATION',
        sections: { assessment: 'After suspension', plan: 'None' },
        reviewState: { allergies: 'REVIEWED', medications: 'REVIEWED' },
      }),
      key(),
    );
    await expect(
      records.signRecord(
        doctor.actor,
        clinic.organizationId,
        'clinicalNote',
        note.id,
        { expectedVersion: 0, attestation: true },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'CREDENTIAL_INVALID' });
    // Upcoming appointments move to the provider's reassignment worklist.
    expect((await Appointment.findById(upcoming.id))!.requiresReassignment).toBe(true);
  });
});

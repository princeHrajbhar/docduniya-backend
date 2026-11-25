/**
 * Marketplace and hospital extensions: intake questionnaires, concern routing, waitlist offers,
 * secure messaging, duplicate identity merge, insurance claims and theatre cases.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { stamp } from '../../src/shared/persistence/schema.js';
import * as patients from '../../src/modules/patients/patient.service.js';
import { Patient, PatientRegistration } from '../../src/modules/patients/patient.model.js';
import * as merge from '../../src/modules/patients/merge.service.js';
import * as appointments from '../../src/modules/appointments/appointment.service.js';
import * as waitlist from '../../src/modules/appointments/waitlist.service.js';
import { WaitlistEntry } from '../../src/modules/appointments/waitlist.model.js';
import { Appointment } from '../../src/modules/appointments/appointment.model.js';
import * as intake from '../../src/modules/intake/intake.service.js';
import * as intakeDto from '../../src/modules/intake/intake.validation.js';
import * as messaging from '../../src/modules/messaging/messaging.service.js';
import * as insurance from '../../src/modules/insurance/insurance.service.js';
import * as invoices from '../../src/modules/billing/invoice.service.js';
import { Invoice } from '../../src/modules/billing/billing.model.js';
import * as encounters from '../../src/modules/clinical/encounter.service.js';
import * as clinicalDto from '../../src/modules/clinical/clinical.validation.js';
import * as procedures from '../../src/modules/procedures/procedure.service.js';
import { CHECKLIST } from '../../src/modules/procedures/procedure.model.js';
import { createLocation } from '../../src/modules/locations/location.service.js';
import { Specialty } from '../../src/modules/practitioners/practitioner.model.js';
import { todayInIndia } from '../../src/shared/domain/healthcare.js';
import {
  account,
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

const concept = (text: string) => ({ text, codings: [] });
let owner: Identity;
let reviewer: Identity;
let doctor: Identity;
let receptionist: Identity;
let clinic: { organizationId: string; facilityId: string };
let offering: Awaited<ReturnType<typeof bookableOffering>>;

async function registeredPatient(name: string) {
  const identity = await account();
  const id = (await patient(identity, name)).id;
  await patients.registerSelfAtProvider(identity.actor, id, clinic, key());
  return { identity, id };
}

beforeAll(async () => {
  await startDatabase();
  owner = await account();
  reviewer = await platformAdmin();
  clinic = await provider(owner, reviewer);
  doctor = await account();
  const doctorProfile = await verifiedDoctor(doctor, reviewer, owner, clinic);
  offering = await bookableOffering(owner, clinic, doctorProfile.affiliationId);
  receptionist = await account();
  await staff(owner, receptionist, clinic.organizationId, clinic.facilityId, 'receptionist');
});
afterAll(stopDatabase);

describe('Intake questionnaires and concern routing', () => {
  it('collects versioned intake for an appointment and shows it only to clinicians', async () => {
    const draft = await intake.createQuestionnaire(
      owner.actor,
      clinic.organizationId,
      intakeDto.questionnaireInput.parse({
        code: 'GENERAL-INTAKE',
        title: 'Before your consultation',
        items: [
          {
            linkId: 'chest_pain',
            text: 'Do you have chest pain now?',
            type: 'BOOLEAN',
            required: true,
            redFlagIfTrue: true,
          },
          {
            linkId: 'chest_detail',
            text: 'Describe the pain',
            type: 'TEXT',
            required: true,
            enableWhen: { linkId: 'chest_pain', equals: 'true' },
          },
          {
            linkId: 'duration',
            text: 'How long have you had symptoms?',
            type: 'CHOICE',
            required: true,
            options: [
              { code: 'days', display: 'A few days' },
              { code: 'weeks', display: 'Weeks or longer' },
            ],
          },
        ],
      }),
      key(),
    );
    const published = await intake.changeQuestionnaireState(
      owner.actor,
      clinic.organizationId,
      draft.id,
      0,
      'PUBLISHED',
      key(),
    );
    await expect(
      intake.updateQuestionnaireDraft(
        owner.actor,
        clinic.organizationId,
        draft.id,
        published.version,
        intakeDto.questionnaireInput.parse({
          code: 'GENERAL-INTAKE',
          title: 'Edited after publication',
          items: [{ linkId: 'x', text: 'x', type: 'TEXT' }],
        }),
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await intake.assignQuestionnaire(
      owner.actor,
      clinic.organizationId,
      offering.offeringId,
      { questionnaireId: draft.id, required: true },
      key(),
    );
    const shown = await intake.offeringQuestionnaire(offering.offeringId);
    expect(shown.questionnaire?.items).toHaveLength(3);

    const person = await account();
    const patientId = (await patient(person)).id;
    const hold = await appointments.createHold(
      person.actor,
      {
        patientId,
        offeringId: offering.offeringId,
        offeringVersion: offering.version,
        priceId: offering.priceId,
        startAt: slot(5, 600),
      },
      key(),
    );
    await expect(
      intake.submitIntake(
        person.actor,
        hold.id,
        {
          answers: [
            { linkId: 'chest_pain', valueBoolean: true },
            { linkId: 'duration', valueCodes: ['days'] },
          ],
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      intake.submitIntake(
        person.actor,
        hold.id,
        {
          answers: [
            { linkId: 'chest_pain', valueBoolean: false },
            { linkId: 'duration', valueCodes: ['months'] },
          ],
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    const submitted = await intake.submitIntake(
      person.actor,
      hold.id,
      {
        answers: [
          { linkId: 'chest_pain', valueBoolean: true },
          { linkId: 'chest_detail', valueString: 'Pressure on exertion' },
          { linkId: 'duration', valueCodes: ['days'] },
        ],
      },
      key(),
    );
    expect(submitted.redFlags).toEqual(['chest_pain']);
    expect(submitted.advice).toMatch(/112/);

    const forDoctor = await intake.appointmentIntake(doctor.actor, clinic.organizationId, hold.id);
    expect(forDoctor.items[0]!.answers).toHaveLength(3);
    for (const outsider of [owner, receptionist])
      await expect(
        intake.appointmentIntake(outsider.actor, clinic.organizationId, hold.id),
      ).rejects.toMatchObject({ statusCode: expect.any(Number) });
    await expect(intake.myIntake((await account()).actor, hold.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await intake.reviewIntake(doctor.actor, clinic.organizationId, submitted.id, 0, key());
  });

  it('routes concerns to specialties under two-person governance and flags emergencies', async () => {
    const specialty = (await Specialty.findOne({ status: 'ACTIVE' }))!;
    const second = await platformAdmin();
    const emergency = await intake.proposeConcern(
      reviewer.actor,
      intakeDto.concernInput.parse({
        code: 'CHEST-PAIN',
        display: 'Chest pain',
        synonyms: ['chest tightness', 'heart pain'],
        specialtyIds: [String(specialty._id)],
        urgency: 'EMERGENCY',
        advice: 'Sudden chest pain can be serious: call 112 or go to an emergency department.',
      }),
      key(),
    );
    await expect(
      intake.decideConcern(reviewer.actor, emergency.id, 0, 'ACTIVE', key()),
    ).rejects.toMatchObject({ statusCode: 403 });
    await intake.decideConcern(second.actor, emergency.id, 0, 'ACTIVE', key());
    const routine = await intake.proposeConcern(
      reviewer.actor,
      intakeDto.concernInput.parse({
        code: 'SKIN-RASH',
        display: 'Skin rash',
        specialtyIds: [String(specialty._id)],
        urgency: 'ROUTINE',
        advice: 'A doctor can examine the rash at a routine appointment.',
      }),
      key(),
    );
    await intake.decideConcern(second.actor, routine.id, 0, 'ACTIVE', key());
    expect((await intake.searchConcerns({ q: 'tightness', limit: 5 })).items[0]!.code).toBe(
      'CHEST-PAIN',
    );
    const urgent = await intake.routeConcerns({ concernCodes: ['CHEST-PAIN', 'SKIN-RASH'] });
    expect(urgent).toMatchObject({ urgency: 'EMERGENCY', bookable: false });
    const plain = await intake.routeConcerns({ concernCodes: ['SKIN-RASH'] });
    expect(plain).toMatchObject({ urgency: 'ROUTINE', bookable: true });
    expect(plain.specialties[0]!.id).toBe(String(specialty._id));
  });
});

describe('Waitlist offers', () => {
  it('offers distinct freed slots in arrival order and books the accepted one', async () => {
    const date = todayInIndia(new Date(Date.now() + 7 * 86400_000));
    const first = await registeredPatient('Waiting First');
    const second = await registeredPatient('Waiting Second');
    const a = await waitlist.joinWaitlist(
      first.identity.actor,
      {
        patientId: first.id,
        offeringId: offering.offeringId,
        earliestDate: date,
        latestDate: date,
      },
      key(),
    );
    await waitlist.joinWaitlist(
      second.identity.actor,
      {
        patientId: second.id,
        offeringId: offering.offeringId,
        earliestDate: date,
        latestDate: date,
      },
      key(),
    );
    await expect(
      waitlist.joinWaitlist(
        first.identity.actor,
        {
          patientId: first.id,
          offeringId: offering.offeringId,
          earliestDate: date,
          latestDate: date,
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await Promise.all([waitlist.offerWaitlistSlots(), waitlist.offerWaitlistSlots()]);
    const offered = await WaitlistEntry.find({
      offeringId: offering.offeringId,
      status: 'OFFERED',
    });
    expect(offered).toHaveLength(2);
    expect(new Set(offered.map((row) => row.offerStartAt!.toISOString())).size).toBe(2);
    const own = offered.find((row) => String(row._id) === a.id)!;
    await expect(waitlist.acceptOffer(second.identity.actor, a.id, key())).rejects.toMatchObject({
      statusCode: 404,
    });
    const booked = await waitlist.acceptOffer(first.identity.actor, a.id, key());
    const appointment = (await Appointment.findById(booked.appointmentId))!;
    expect(appointment.status).toBe('HELD');
    expect(appointment.startAt.toISOString()).toBe(own.offerStartAt!.toISOString());
    expect((await WaitlistEntry.findById(a.id))!.status).toBe('BOOKED');

    // A lapsed offer returns to the queue and is offered again.
    const other = offered.find((row) => String(row._id) !== a.id)!;
    await WaitlistEntry.updateOne(
      { _id: other._id },
      { $set: { offerExpiresAt: new Date(Date.now() - 1000) } },
    );
    await waitlist.offerWaitlistSlots();
    const again = (await WaitlistEntry.findById(other._id))!;
    expect(again.status).toBe('OFFERED');
    expect(again.offerCount).toBe(2);
  });
});

describe('Secure messaging', () => {
  it('keeps care threads within the care team and admin threads with the front desk', async () => {
    const person = await registeredPatient('Messaging Patient');
    const care = await messaging.patientStartConversation(
      person.identity.actor,
      person.id,
      messaging.conversationInput.parse({
        organizationId: clinic.organizationId,
        kind: 'CARE',
        subject: 'Question about my medicine',
        body: 'Can I take it with food?',
      }),
      key(),
    );
    await expect(
      messaging.providerMessages(doctor.actor, clinic.organizationId, care.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      messaging.providerMessages(receptionist.actor, clinic.organizationId, care.id),
    ).rejects.toMatchObject({ statusCode: 403 });
    await encounters.startEncounter(
      doctor.actor,
      clinic.organizationId,
      clinicalDto.encounterInput.parse({
        patientId: person.id,
        facilityId: clinic.facilityId,
        queueEntryId: await walkIn(owner, clinic, person.id),
        type: concept('Consultation'),
        chiefComplaint: 'Follow-up',
      }),
      key(),
    );
    const thread = await messaging.providerMessages(doctor.actor, clinic.organizationId, care.id);
    expect(thread.messages).toHaveLength(1);
    await messaging.providerPost(
      doctor.actor,
      clinic.organizationId,
      care.id,
      { body: 'Yes, after meals.', documentIds: [] },
      key(),
    );
    const inbox = await messaging.patientConversations(person.identity.actor, person.id);
    expect(inbox.items[0]).toMatchObject({ unread: true, messageCount: 2 });
    const read = await messaging.patientMessages(person.identity.actor, care.id);
    expect(read.messages.map((row) => row.side)).toEqual(['PATIENT', 'PROVIDER']);
    expect(JSON.stringify(read)).not.toContain(doctor.userId);
    await expect(messaging.patientMessages((await account()).actor, care.id)).rejects.toMatchObject(
      { statusCode: 404 },
    );

    const admin = await messaging.patientStartConversation(
      person.identity.actor,
      person.id,
      messaging.conversationInput.parse({
        organizationId: clinic.organizationId,
        kind: 'ADMINISTRATIVE',
        subject: 'Invoice question',
        body: 'Please resend my invoice.',
      }),
      key(),
    );
    await messaging.providerPost(
      receptionist.actor,
      clinic.organizationId,
      admin.id,
      { body: 'Sent to your account.', documentIds: [] },
      key(),
    );
    const desk = await messaging.providerInbox(receptionist.actor, clinic.organizationId, {
      kind: 'ADMINISTRATIVE',
      status: 'OPEN',
      limit: 10,
    });
    expect(desk.items.map((row) => row.id)).toContain(admin.id);
    // Not registered with this provider: no unsolicited threads.
    const stranger = await account();
    const strangerPatient = (await patient(stranger)).id;
    await expect(
      messaging.patientStartConversation(
        stranger.actor,
        strangerPatient,
        messaging.conversationInput.parse({
          organizationId: clinic.organizationId,
          kind: 'ADMINISTRATIVE',
          subject: 'Hello there',
          body: 'Spam',
        }),
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('Duplicate identity merge', () => {
  it('merges an unclaimed provider record into the patient after independent review', async () => {
    const person = await registeredPatient('Merge Survivor');
    const duplicate = await Patient.create({
      ...stamp(owner.userId),
      name: { display: 'Merge Survivor' },
      birthDate: '1990-05-01',
      birthDatePrecision: 'EXACT',
      administrativeSex: 'FEMALE',
      preferredLanguage: 'en',
      status: 'TEMPORARY',
    });
    const request = await merge.requestMerge(
      person.identity.actor,
      {
        sourcePatientId: String(duplicate._id),
        targetPatientId: person.id,
        evidence: 'Same name and birth date; registered at the clinic front desk before sign-up.',
      },
      key(),
    );
    const decision = {
      expectedVersion: 0,
      decision: 'APPROVED' as const,
      reason: 'Identity documents match the provider record.',
      checks: { identityMatched: true as const, noConflictingRecords: true as const },
    };
    await expect(
      merge.decideMerge(person.identity.actor, request.id, decision, key()),
    ).rejects.toMatchObject({ statusCode: 403 });
    await merge.decideMerge(reviewer.actor, request.id, decision, key());
    expect((await Patient.findById(duplicate._id))!).toMatchObject({ status: 'MERGED' });
    expect((await merge.patientIdentityIds(person.id)).map(String)).toContain(
      String(duplicate._id),
    );
    // An account-owned identity is never absorbed.
    const other = await registeredPatient('Account Owner');
    await expect(
      merge.requestMerge(
        person.identity.actor,
        {
          sourcePatientId: other.id,
          targetPatientId: person.id,
          evidence: 'Attempt to take over another account holder identity.',
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('Insurance claims', () => {
  it('claims issued invoices once, adjudicates and posts the remittance to the ledger', async () => {
    const person = await registeredPatient('Insured Patient');
    const payer = await insurance.createPayer(
      reviewer.actor,
      { code: 'SYNTH-INSURER', name: 'Synthetic Insurance', kind: 'INSURER' },
      key(),
    );
    const coverage = await insurance.addCoverage(
      person.identity.actor,
      person.id,
      insurance.coverageInput.parse({
        payerId: payer.id,
        memberId: 'MEM-001',
        policyNumber: 'POL-001',
        holderName: 'Insured Patient',
        relationshipToHolder: 'SELF',
        validFrom: todayInIndia(new Date(Date.now() - 86400_000)),
        validUntil: todayInIndia(new Date(Date.now() + 300 * 86400_000)),
      }),
      key(),
    );
    const registration = (await PatientRegistration.findOne({
      organizationId: clinic.organizationId,
      patientId: person.id,
    }))!;
    const draft = await invoices.createInvoice(
      owner.actor,
      clinic.organizationId,
      {
        patientRegistrationId: String(registration._id),
        facilityId: clinic.facilityId,
        chargeItemIds: [],
        lines: [
          {
            description: 'Day-care procedure',
            quantity: 1,
            unitPriceMinor: 100_000,
            discountMinor: 0,
            taxBasisPoints: 0,
          },
        ],
        dueInDays: 30,
      },
      key(),
    );
    const issued = await invoices.issueInvoice(
      owner.actor,
      clinic.organizationId,
      draft.id,
      draft.version,
      key(),
    );
    const claimBody = { coverageId: coverage.id, invoiceIds: [draft.id], claimedMinor: 100_000 };
    await expect(
      insurance.submitClaim(
        owner.actor,
        clinic.organizationId,
        { ...claimBody, claimedMinor: 100_001 },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    const claim = await insurance.submitClaim(owner.actor, clinic.organizationId, claimBody, key());
    await expect(
      insurance.submitClaim(owner.actor, clinic.organizationId, claimBody, key()),
    ).rejects.toMatchObject({ statusCode: 409 });
    const adjudicated = await insurance.adjudicateClaim(
      owner.actor,
      clinic.organizationId,
      claim.id,
      insurance.payerDecisionInput.parse({
        expectedVersion: 0,
        decision: 'PARTIALLY_APPROVED',
        approvedMinor: 80_000,
        payerReference: 'ADJ-1',
        reason: 'Room rent capped by policy terms',
      }),
      key(),
    );
    await expect(
      insurance.settleClaim(
        owner.actor,
        clinic.organizationId,
        claim.id,
        { expectedVersion: adjudicated.version, amountMinor: 90_000, remittanceReference: 'UTR-1' },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await insurance.settleClaim(
      owner.actor,
      clinic.organizationId,
      claim.id,
      { expectedVersion: adjudicated.version, amountMinor: 80_000, remittanceReference: 'UTR-1' },
      key(),
    );
    const invoice = (await Invoice.findById(draft.id))!;
    expect(invoices.outstanding(invoice)).toBe(20_000);
    expect(issued).toBeTruthy();
    const { trialBalance } = await import('../../src/modules/billing/ledger.service.js');
    expect((await trialBalance(owner.actor, clinic.organizationId)).balanced).toBe(true);
  });
});

describe('Theatre cases', () => {
  it('books theatres without overlap and enforces the surgical safety checklist in order', async () => {
    const person = await registeredPatient('Surgical Patient');
    const encounter = await encounters.startEncounter(
      doctor.actor,
      clinic.organizationId,
      clinicalDto.encounterInput.parse({
        patientId: person.id,
        facilityId: clinic.facilityId,
        queueEntryId: await walkIn(owner, clinic, person.id),
        type: concept('Surgical consultation'),
        chiefComplaint: 'Inguinal hernia',
      }),
      key(),
    );
    const theatre = await createLocation(
      owner.actor,
      clinic.organizationId,
      {
        facilityId: clinic.facilityId,
        code: 'OT-1',
        name: 'Theatre 1',
        kind: 'THEATRE',
        capabilities: [],
        isolationCapable: false,
      },
      key(),
    );
    const nurse = await account();
    await professional(nurse, 'NURSE');
    await staff(owner, nurse, clinic.organizationId, clinic.facilityId, 'nurse');
    const request = () =>
      procedures.requestProcedure(
        doctor.actor,
        clinic.organizationId,
        procedures.procedureRequestInput.parse({
          encounterId: encounter.id,
          procedure: concept('Inguinal hernia repair'),
          laterality: 'LEFT',
          priority: 'ELECTIVE',
          estimatedMinutes: 90,
        }),
        key(),
      );
    const first = await request();
    const second = await request();
    const start = new Date(Date.now() + 2 * 86400_000);
    const team = [
      { userId: doctor.userId, role: 'SURGEON' as const },
      { userId: nurse.userId, role: 'SCRUB_NURSE' as const },
    ];
    const scheduled = await procedures.scheduleProcedure(
      owner.actor,
      clinic.organizationId,
      first.id,
      { expectedVersion: 0, theatreId: theatre.id, scheduledStart: start.toISOString(), team },
      key(),
    );
    await expect(
      procedures.scheduleProcedure(
        owner.actor,
        clinic.organizationId,
        second.id,
        {
          expectedVersion: 0,
          theatreId: theatre.id,
          scheduledStart: new Date(start.getTime() + 30 * 60_000).toISOString(),
          team,
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      procedures.startProcedure(
        doctor.actor,
        clinic.organizationId,
        first.id,
        scheduled.version,
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      procedures.completeChecklist(
        nurse.actor,
        clinic.organizationId,
        first.id,
        'SIGN_IN',
        { expectedVersion: scheduled.version, confirmed: ['IDENTITY_CONFIRMED'] },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    const signIn = await procedures.completeChecklist(
      nurse.actor,
      clinic.organizationId,
      first.id,
      'SIGN_IN',
      { expectedVersion: scheduled.version, confirmed: [...CHECKLIST.SIGN_IN] },
      key(),
    );
    const timeOut = await procedures.completeChecklist(
      doctor.actor,
      clinic.organizationId,
      first.id,
      'TIME_OUT',
      { expectedVersion: signIn.version, confirmed: [...CHECKLIST.TIME_OUT] },
      key(),
    );
    await expect(
      procedures.startProcedure(
        nurse.actor,
        clinic.organizationId,
        first.id,
        timeOut.version,
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const started = await procedures.startProcedure(
      doctor.actor,
      clinic.organizationId,
      first.id,
      timeOut.version,
      key(),
    );
    const signOut = await procedures.completeChecklist(
      nurse.actor,
      clinic.organizationId,
      first.id,
      'SIGN_OUT',
      { expectedVersion: started.version, confirmed: [...CHECKLIST.SIGN_OUT] },
      key(),
    );
    await procedures.completeProcedure(
      doctor.actor,
      clinic.organizationId,
      first.id,
      { expectedVersion: signOut.version, outcomeSummary: 'Uncomplicated mesh repair.' },
      key(),
    );
    const done = await procedures.getProcedure(nurse.actor, clinic.organizationId, first.id);
    expect(done).toMatchObject({ status: 'COMPLETED' });
    const board = await procedures.theatreSchedule(owner.actor, clinic.organizationId, {
      facilityId: clinic.facilityId,
      date: todayInIndia(start),
    });
    expect(board.items.map((row) => row.id)).toContain(first.id);
    expect(JSON.stringify(board)).not.toContain('hernia');
  });
});

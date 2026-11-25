import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { canonical, command, conflict } from '../../shared/application/command.js';
import { before, pageOf, scoped } from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';
import { authorizeOrganization } from '../access/access.service.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { authorizePatient, patientDemographics } from '../patients/patient.service.js';
import { Patient, PatientRegistration } from '../patients/patient.model.js';
import { Organization } from '../organizations/organization.model.js';
import { AuditEvent } from '../operations/operation.model.js';
import { recordChange, recordRead } from '../operations/operation.service.js';
import { Appointment } from '../appointments/appointment.model.js';
import { Invoice } from '../billing/billing.model.js';
import { patientRecords } from '../clinical/clinical-query.service.js';
import { patientReports } from '../diagnostics/diagnostic-query.service.js';
import { ownPractitioner } from '../clinical/clinical.policy.js';
import {
  AccessGrant,
  Consent,
  ConsentEvent,
  PolicyAcknowledgement,
  PolicyVersion,
  PrivacyRequest,
  RetentionHold,
} from './privacy.model.js';
import type {
  acknowledgementInput,
  auditQuery,
  consentQuery,
  emergencyAccessInput,
  emergencyReviewInput,
  policyInput,
  privacyDecisionInput,
  privacyRequestInput,
  providerConsentInput,
  retentionHoldInput,
  sharingConsentInput,
  withdrawInput,
} from './privacy.validation.js';

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const EMERGENCY_HOURS = 4;
const REVIEW_HOURS = 72;

// ── Policies ─────────────────────────────────────────────────────────────────

export async function publishPolicy(
  actor: CommandActor,
  input: z.infer<typeof policyInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.PRIVACY_MANAGE);
  return command(actor, 'platform', 'policy.publish', key, input, async (session) => {
    const latest = await PolicyVersion.findOne({ code: input.code, language: input.language })
      .sort({ versionNumber: -1 })
      .session(session);
    try {
      const [policy] = await PolicyVersion.create(
        [
          {
            ...input,
            effectiveFrom: new Date(input.effectiveFrom),
            versionNumber: (latest?.versionNumber ?? 0) + 1,
            contentHash: hash(input.text),
            approvedBy: { kind: 'USER', id: actor.userId },
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          action: 'PolicyPublished',
          resourceType: 'policyVersion',
          resourceId: String(policy!._id),
          version: 0,
        },
        session,
      );
      return { id: String(policy!._id), version: 0 };
    } catch (error) {
      if (isDuplicateKeyError(error)) conflict('A concurrent policy version was published');
      throw error;
    }
  });
}

export async function currentPolicies(language = 'en') {
  const rows = await PolicyVersion.aggregate<{ _id: string; policy: Record<string, unknown> }>([
    { $match: { language, effectiveFrom: { $lte: new Date() } } },
    { $sort: { versionNumber: -1 } },
    { $group: { _id: '$code', policy: { $first: '$$ROOT' } } },
  ]);
  return rows.map(({ policy }) => ({
    id: String(policy._id),
    kind: policy.kind,
    code: policy.code,
    versionNumber: policy.versionNumber,
    title: policy.title,
    text: policy.text,
    contentHash: policy.contentHash,
    effectiveFrom: policy.effectiveFrom,
  }));
}

/** Evidence that a version was shown and accepted; never a substitute for specific consent. */
export async function acknowledgePolicy(
  actor: CommandActor,
  input: z.infer<typeof acknowledgementInput>,
) {
  const policy = await PolicyVersion.findById(input.policyVersionId);
  if (!policy) throw ApiError.notFound();
  if (input.patientId) await authorizePatient(actor, input.patientId, 'consent.manage');
  const acceptedAt = new Date();
  try {
    const [row] = await PolicyAcknowledgement.create([
      {
        userId: actor.userId,
        patientId: input.patientId,
        policyVersionId: policy._id,
        acceptedAt,
        channel: input.channel,
        evidenceHash: hash({ userId: actor.userId, policy: policy.contentHash, acceptedAt }),
      },
    ]);
    return { id: String(row!._id), version: 0 };
  } catch (error) {
    if (isDuplicateKeyError(error))
      return { id: String(policy._id), version: 0, alreadyAccepted: true };
    throw error;
  }
}

// ── Consent and sharing grants ───────────────────────────────────────────────

async function appendConsentEvent(
  actor: CommandActor,
  consent: ReturnType<typeof Consent.hydrate>,
  type: 'GRANTED' | 'WITHDRAWN',
  session: Parameters<typeof scoped>[3],
  reason?: string,
) {
  await ConsentEvent.create(
    [
      {
        consentId: consent._id,
        patientId: consent.patientId,
        sequence: consent.version,
        type,
        reason,
        evidenceHash: consent.evidenceHash,
        effectiveAt: new Date(),
        actor: { kind: 'USER', id: actor.userId },
      },
    ],
    { session },
  );
}

/** Patient (or verified representative) shares chosen record families with one provider. */
export async function grantRecordSharing(
  actor: CommandActor,
  patientId: string,
  input: z.infer<typeof sharingConsentInput>,
  key: string,
) {
  return command(actor, 'self', `consent.share:${patientId}`, key, input, async (session) => {
    const patient = await authorizePatient(actor, patientId, 'consent.manage', session, true);
    if (
      !(await Organization.exists({ _id: input.recipientOrganizationId, status: 'ACTIVE' }).session(
        session,
      ))
    )
      throw ApiError.notFound('Provider is unavailable');
    const policy = input.policyVersionId
      ? await PolicyVersion.findById(input.policyVersionId).session(session)
      : null;
    if (input.policyVersionId && !policy)
      throw ApiError.notFound('Consent text version is unavailable');
    const now = new Date();
    const scope = {
      recipientOrganizationId: input.recipientOrganizationId,
      purposes: input.purposes,
      resourceTypes: input.resourceTypes,
      recordPeriodStart: input.recordPeriodStart ? new Date(input.recordPeriodStart) : undefined,
      recordPeriodEnd: input.recordPeriodEnd ? new Date(input.recordPeriodEnd) : undefined,
      expiresAt: new Date(input.expiresAt),
    };
    const [consent] = await Consent.create(
      [
        {
          ...stamp(actor.userId),
          patientId,
          kind: 'RECORD_SHARING',
          policyVersionId: policy?._id,
          grantorUserId: actor.userId,
          grantorRelationship:
            String(patient.ownerUserId) === actor.userId ? 'SELF' : 'REPRESENTATIVE',
          ...scope,
          validFrom: now,
          evidenceHash: hash({
            ...scope,
            patientId,
            grantor: actor.userId,
            policy: policy?.contentHash,
            at: now,
          }),
        },
      ],
      { session },
    );
    await appendConsentEvent(actor, consent!, 'GRANTED', session);
    await AccessGrant.create(
      [
        {
          ...stamp(actor.userId),
          patientId,
          recipient: { kind: 'ORGANIZATION', id: input.recipientOrganizationId },
          consentId: consent!._id,
          basis: 'CONSENT',
          purpose: input.purposes.join(','),
          resourceTypes: input.resourceTypes,
          recordPeriodStart: scope.recordPeriodStart,
          recordPeriodEnd: scope.recordPeriodEnd,
          validFrom: now,
          expiresAt: scope.expiresAt,
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        patientId,
        action: 'RecordSharingConsented',
        resourceType: 'consent',
        resourceId: String(consent!._id),
        version: 0,
      },
      session,
    );
    return { id: String(consent!._id), version: 0 };
  });
}

/** Withdrawal stops future consent-dependent access immediately; copies already disclosed remain. */
export async function withdrawConsent(
  actor: CommandActor,
  consentId: string,
  input: z.infer<typeof withdrawInput>,
  key: string,
) {
  const preview = await Consent.findById(consentId);
  if (!preview) throw ApiError.notFound();
  await authorizePatient(actor, String(preview.patientId), 'consent.manage');
  return command(actor, 'self', `consent.withdraw:${consentId}`, key, input, async (session) => {
    const consent = await Consent.findOne({
      _id: consentId,
      version: input.expectedVersion,
      status: 'ACTIVE',
    }).session(session);
    if (!consent) conflict();
    await authorizePatient(actor, String(consent.patientId), 'consent.manage', session, true);
    consent.set({
      status: 'WITHDRAWN',
      withdrawnAt: new Date(),
      updatedBy: { kind: 'USER', id: actor.userId },
    });
    await consent.save({ session });
    await appendConsentEvent(actor, consent, 'WITHDRAWN', session, input.reason);
    await AccessGrant.updateMany(
      { consentId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), reason: input.reason }, $inc: { version: 1 } },
      { session },
    );
    await recordChange(
      actor,
      {
        patientId: String(consent.patientId),
        action: 'ConsentWithdrawn',
        resourceType: 'consent',
        resourceId: consentId,
        version: consent.version,
        reason: input.reason,
      },
      session,
    );
    return { id: consentId, version: consent.version };
  });
}

/** A provider records telemedicine or procedure consent obtained from the patient. */
export async function recordProviderConsent(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof providerConsentInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `consent.record:${input.patientId}`,
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'consents.record', session, { activeProvider: true });
      await ownPractitioner(actor, session);
      if (
        !(await PatientRegistration.exists({
          organizationId,
          patientId: input.patientId,
          status: 'ACTIVE',
        }).session(session))
      )
        throw ApiError.notFound('Patient registration is unavailable');
      const now = new Date();
      const [consent] = await Consent.create(
        [
          {
            ...stamp(actor.userId),
            patientId: input.patientId,
            kind: input.kind,
            organizationId,
            policyVersionId: input.policyVersionId,
            grantorUserId: actor.userId,
            grantorRelationship: 'RECORDED_BY_PROVIDER',
            procedureDescription: input.procedureDescription,
            validFrom: now,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
            evidenceHash: hash({ ...input, recordedBy: actor.userId, at: now }),
          },
        ],
        { session },
      );
      await appendConsentEvent(actor, consent!, 'GRANTED', session);
      await recordChange(
        actor,
        {
          organizationId,
          patientId: input.patientId,
          action: `${input.kind}ConsentRecorded`,
          resourceType: 'consent',
          resourceId: String(consent!._id),
          version: 0,
        },
        session,
      );
      return { id: String(consent!._id), version: 0 };
    },
  );
}

export async function listPatientConsents(
  actor: CommandActor,
  patientId: string,
  query: z.infer<typeof consentQuery>,
) {
  await authorizePatient(actor, patientId, 'consent.manage');
  const rows = await Consent.find({
    patientId,
    ...(query.status ? { status: query.status } : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  const organizations = await Organization.find({
    _id: {
      $in: rows.flatMap((row) => [row.recipientOrganizationId, row.organizationId].filter(Boolean)),
    },
  })
    .select({ displayName: 1 })
    .lean();
  const names = new Map(organizations.map((row) => [String(row._id), row.displayName]));
  return pageOf(rows, query.limit, (row) => ({
    id: String(row._id),
    kind: row.kind,
    recipient: row.recipientOrganizationId
      ? {
          id: String(row.recipientOrganizationId),
          name: names.get(String(row.recipientOrganizationId)),
        }
      : undefined,
    recordedBy: row.organizationId ? names.get(String(row.organizationId)) : undefined,
    purposes: row.purposes,
    resourceTypes: row.resourceTypes,
    validFrom: row.validFrom,
    expiresAt: row.expiresAt,
    status: row.status,
    version: row.version,
  }));
}

// ── Emergency access ─────────────────────────────────────────────────────────

/**
 * Break-glass: an eligible clinician at a provider where the patient is registered gains short,
 * named, audited chart access. Every use is reviewed afterwards.
 */
export async function emergencyAccess(
  actor: CommandActor,
  organizationId: string,
  patientId: string,
  input: z.infer<typeof emergencyAccessInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `emergency-access:${patientId}`,
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'clinical.read', session, { activeProvider: true });
      await ownPractitioner(actor, session, ['DOCTOR', 'NURSE']);
      if (
        !(await PatientRegistration.exists({ organizationId, patientId, status: 'ACTIVE' }).session(
          session,
        ))
      )
        throw ApiError.notFound('Patient chart is unavailable');
      const now = new Date();
      const [grant] = await AccessGrant.create(
        [
          {
            ...stamp(actor.userId),
            patientId,
            recipient: { kind: 'USER', id: actor.userId },
            organizationId,
            basis: 'EMERGENCY',
            purpose: 'EMERGENCY_TREATMENT',
            resourceTypes: [
              'encounters',
              'clinicalNotes',
              'diagnoses',
              'observations',
              'allergies',
              'conditions',
              'medicationStatements',
              'prescriptions',
              'diagnosticReports',
              'immunizations',
              'documents',
            ],
            validFrom: now,
            expiresAt: new Date(now.getTime() + EMERGENCY_HOURS * 3600_000),
            reason: input.reason,
            breakGlassReviewDueAt: new Date(now.getTime() + REVIEW_HOURS * 3600_000),
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId,
          action: 'EmergencyAccessGranted',
          resourceType: 'accessGrant',
          resourceId: String(grant!._id),
          version: 0,
          reason: input.reason,
        },
        session,
      );
      return { id: String(grant!._id), version: 0 };
    },
  );
}

export async function listEmergencyAccess(
  actor: CommandActor,
  organizationId: string,
  page: Pagination,
) {
  await authorizeOrganization(actor, organizationId, 'audit.read', { organizationWide: true });
  const rows = await AccessGrant.find({
    organizationId,
    basis: 'EMERGENCY',
    ...before(page.before),
  })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return pageOf(rows, page.limit, (row) => ({
    id: String(row._id),
    patientId: String(row.patientId),
    userId: String(row.recipient.id),
    reason: row.reason,
    validFrom: row.validFrom,
    expiresAt: row.expiresAt,
    reviewDueAt: row.breakGlassReviewDueAt,
    reviewedAt: row.reviewedAt,
    reviewOutcome: row.reviewOutcome,
    version: row.version,
  }));
}

export async function reviewEmergencyAccess(
  actor: CommandActor,
  organizationId: string,
  grantId: string,
  input: z.infer<typeof emergencyReviewInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `emergency-review:${grantId}`,
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'audit.read', session, { organizationWide: true });
      const grant = await AccessGrant.findOne({
        _id: grantId,
        organizationId,
        basis: 'EMERGENCY',
        version: input.expectedVersion,
      }).session(session);
      if (!grant) conflict();
      if (String(grant.recipient.id) === actor.userId)
        throw ApiError.forbidden('Emergency access is reviewed by someone else');
      if (grant.reviewedAt) conflict('Already reviewed');
      grant.set({
        reviewedAt: new Date(),
        reviewedBy: actor.userId,
        reviewOutcome: input.outcome,
        reviewNote: input.note,
        updatedBy: { kind: 'USER', id: actor.userId },
      });
      if (grant.expiresAt > new Date()) grant.revokedAt = new Date();
      await grant.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(grant.patientId),
          action: `EmergencyAccessReviewed.${input.outcome}`,
          resourceType: 'accessGrant',
          resourceId: grantId,
          version: grant.version,
          reason: input.note,
        },
        session,
      );
      return { id: grantId, version: grant.version };
    },
  );
}

// ── Privacy requests, export and retention ───────────────────────────────────

export async function createPrivacyRequest(
  actor: CommandActor,
  patientId: string,
  input: z.infer<typeof privacyRequestInput>,
  key: string,
) {
  return command(actor, 'self', `privacy-request:${patientId}`, key, input, async (session) => {
    await authorizePatient(actor, patientId, 'consent.manage', session);
    const [row] = await PrivacyRequest.create(
      [
        {
          ...stamp(actor.userId),
          patientId,
          requesterId: actor.userId,
          ...input,
          dueAt: new Date(Date.now() + 30 * 86400_000),
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId: input.organizationId,
        patientId,
        action: `PrivacyRequest.${input.kind}`,
        resourceType: 'privacyRequest',
        resourceId: String(row!._id),
        version: 0,
      },
      session,
    );
    return { id: String(row!._id), version: 0 };
  });
}

export async function listPrivacyRequests(
  actor: CommandActor,
  page: Pagination,
  patientId?: string,
) {
  if (patientId) await authorizePatient(actor, patientId, 'consent.manage');
  else await requirePlatformPermission(actor, PERMISSIONS.PRIVACY_MANAGE);
  const rows = await PrivacyRequest.find({
    ...(patientId ? { patientId } : { status: { $nin: ['COMPLETED', 'REJECTED'] } }),
    ...before(page.before),
  })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return pageOf(rows, page.limit, (row) => ({
    id: String(row._id),
    patientId: String(row.patientId),
    kind: row.kind,
    status: row.status,
    dueAt: row.dueAt,
    reason: row.reason,
    decisionReason: row.decisionReason,
    version: row.version,
  }));
}

/** Erasure is decided against legal retention and holds; clinical and financial records are retained. */
export async function decidePrivacyRequest(
  actor: CommandActor,
  requestId: string,
  input: z.infer<typeof privacyDecisionInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.PRIVACY_MANAGE);
  return command(
    actor,
    'platform',
    `privacy-request.decide:${requestId}`,
    key,
    input,
    async (session) => {
      const request = await PrivacyRequest.findOne({
        _id: requestId,
        version: input.expectedVersion,
      }).session(session);
      if (!request) conflict();
      if (['COMPLETED', 'REJECTED'].includes(request.status)) conflict('The request is closed');
      if (
        request.kind === 'ERASURE' &&
        input.status === 'COMPLETED' &&
        (await RetentionHold.exists({
          'scope.patientId': request.patientId,
          releasedAt: { $exists: false },
        }).session(session))
      )
        conflict('A retention hold applies; record a partial completion with the reason');
      request.set({
        status: input.status,
        decisionReason: input.decisionReason,
        assigneeId: actor.userId,
        completedAt: ['COMPLETED', 'PARTIALLY_COMPLETED', 'REJECTED'].includes(input.status)
          ? new Date()
          : undefined,
        updatedBy: { kind: 'USER', id: actor.userId },
      });
      await request.save({ session });
      await recordChange(
        actor,
        {
          patientId: String(request.patientId),
          action: `PrivacyRequest.${input.status}`,
          resourceType: 'privacyRequest',
          resourceId: requestId,
          version: request.version,
          reason: input.decisionReason,
        },
        session,
      );
      return { id: requestId, version: request.version };
    },
  );
}

/** Machine-readable export of the patient's own data across providers; audited before disclosure. */
export async function exportPatientData(actor: CommandActor, patientId: string) {
  await authorizePatient(actor, patientId, 'medical.export');
  const patient = await Patient.findById(patientId);
  if (!patient) throw ApiError.notFound();
  await recordRead(actor, 'patientExport', patientId, undefined, patientId);
  const [registrations, appointments, invoices, consents, records, reports] = await Promise.all([
    PatientRegistration.find({ patientId }).lean(),
    Appointment.find({ patientId }).sort({ startAt: -1 }).limit(500).lean(),
    Invoice.find({ patientId, status: 'ISSUED' }).sort({ issuedAt: -1 }).limit(500).lean(),
    Consent.find({ patientId }).lean(),
    patientRecords(actor, patientId),
    patientReports(actor, patientId),
  ]);
  const organizations = await Organization.find({
    _id: { $in: registrations.map((row) => row.organizationId) },
  })
    .select({ displayName: 1 })
    .lean();
  const names = new Map(organizations.map((row) => [String(row._id), row.displayName]));
  return {
    format: 'docduniya-patient-export',
    formatVersion: 1,
    generatedAt: new Date(),
    profile: patientDemographics(patient),
    registrations: registrations.map((row) => ({
      provider: names.get(String(row.organizationId)),
      mrn: row.mrn,
      registeredAt: row.createdAt,
    })),
    appointments: appointments.map((row) => ({
      bookingNumber: row.bookingNumber,
      provider: names.get(String(row.organizationId)),
      service: row.offeringSnapshot.name,
      startAt: row.startAt,
      status: row.status,
      price: row.priceSnapshot,
    })),
    invoices: invoices.map((row) => ({
      number: row.number,
      seller: row.seller.name,
      issuedAt: row.issuedAt,
      totalMinor: row.totalMinor,
      creditedMinor: row.creditedMinor,
      paidMinor: row.allocatedMinor,
    })),
    consents: consents.map((row) => ({
      kind: row.kind,
      status: row.status,
      resourceTypes: row.resourceTypes,
      validFrom: row.validFrom,
      expiresAt: row.expiresAt,
      withdrawnAt: row.withdrawnAt,
    })),
    clinical: records,
    diagnosticReports: reports,
  };
}

export async function placeRetentionHold(
  actor: CommandActor,
  input: z.infer<typeof retentionHoldInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.PRIVACY_MANAGE);
  return command(actor, 'platform', 'retention-hold.place', key, input, async (session) => {
    const [hold] = await RetentionHold.create(
      [
        {
          ...stamp(actor.userId),
          scope: input.organizationId
            ? { kind: 'ORGANIZATION', organizationId: input.organizationId }
            : { kind: 'PATIENT', patientId: input.patientId },
          reason: input.reason,
          startsAt: new Date(),
          approvedBy: actor.userId,
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId: input.organizationId,
        patientId: input.patientId,
        action: 'RetentionHoldPlaced',
        resourceType: 'retentionHold',
        resourceId: String(hold!._id),
        version: 0,
        reason: input.reason,
      },
      session,
    );
    return { id: String(hold!._id), version: 0 };
  });
}

// ── Audit views ──────────────────────────────────────────────────────────────

const presentAudit = (row: Record<string, unknown>) => ({
  id: String(row._id),
  occurredAt: row.occurredAt,
  action: row.action,
  outcome: row.outcome,
  actor: row.actor,
  resourceType: row.resourceType,
  resourceId: String(row.resourceId),
  organizationId: row.organizationId ? String(row.organizationId) : undefined,
  patientId: row.patientId ? String(row.patientId) : undefined,
  reason: row.reason,
  requestId: row.requestId,
});

/** Investigative access is itself audited. */
export async function organizationAudit(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof auditQuery>,
) {
  await authorizeOrganization(actor, organizationId, 'audit.read', { organizationWide: true });
  const rows = await AuditEvent.find({
    organizationId,
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  await recordRead(actor, 'auditEvents', organizationId, organizationId, query.patientId);
  return pageOf(rows, query.limit, presentAudit);
}

export async function platformAudit(actor: CommandActor, query: z.infer<typeof auditQuery>) {
  await requirePlatformPermission(actor, PERMISSIONS.AUDIT_READ);
  const rows = await AuditEvent.find({
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, presentAudit);
}

/** Patients see which providers read their records; individual staff identities are not disclosed. */
export async function patientAccessHistory(
  actor: CommandActor,
  patientId: string,
  page: Pagination,
) {
  await authorizePatient(actor, patientId, 'medical.read');
  const rows = await AuditEvent.find({ patientId, outcome: 'ALLOW', ...before(page.before) })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  const organizations = await Organization.find({
    _id: { $in: rows.map((row) => row.organizationId).filter(Boolean) },
  })
    .select({ displayName: 1 })
    .lean();
  const names = new Map(organizations.map((row) => [String(row._id), row.displayName]));
  return pageOf(rows, page.limit, (row) => ({
    occurredAt: row.occurredAt,
    action: row.action,
    provider: row.organizationId
      ? (names.get(String(row.organizationId)) ?? 'Provider')
      : row.actor.id === actor.userId
        ? 'You'
        : 'Authorized representative',
  }));
}

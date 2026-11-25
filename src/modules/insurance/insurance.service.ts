import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { objectId, todayInIndia } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import {
  before,
  formatNumber,
  nextNumber,
  pageOf,
  presentRow,
  scoped,
} from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { authorizeOrganization } from '../access/access.service.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { authorizePatient } from '../patients/patient.service.js';
import { PatientRegistration } from '../patients/patient.model.js';
import { recordChange } from '../operations/operation.service.js';
import { Invoice, Payment } from '../billing/billing.model.js';
import { allocate, outstanding, postReceipt } from '../billing/invoice.service.js';
import {
  ClaimInvoice,
  InsuranceClaim,
  InsuranceCoverage,
  Payer,
  Preauthorization,
} from './insurance.model.js';

const version = z.number().int().min(0);
const reason = z.string().trim().min(10).max(1000);
const day = z.iso.date();
export const payerInput = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/u),
  name: z.string().trim().min(2).max(200),
  kind: z.enum(['INSURER', 'TPA', 'GOVERNMENT_SCHEME', 'CORPORATE']),
});
export const coverageInput = z
  .strictObject({
    payerId: objectId,
    memberId: z.string().trim().min(2).max(60),
    policyNumber: z.string().trim().min(2).max(60),
    planName: z.string().trim().max(200).optional(),
    holderName: z.string().trim().min(2).max(200),
    relationshipToHolder: z.enum(['SELF', 'SPOUSE', 'CHILD', 'PARENT', 'OTHER']),
    validFrom: day,
    validUntil: day,
  })
  .refine((v) => v.validFrom <= v.validUntil, { message: 'The policy must end after it starts' });
export const preauthInput = z.strictObject({
  patientRegistrationId: objectId,
  coverageId: objectId,
  facilityId: objectId,
  admissionId: objectId.optional(),
  treatmentSummary: z.string().trim().min(10).max(2000),
  requestedMinor: z.number().int().positive(),
});
export const payerDecisionInput = z
  .strictObject({
    expectedVersion: version,
    decision: z.enum(['APPROVED', 'PARTIALLY_APPROVED', 'DENIED']),
    approvedMinor: z.number().int().min(0).optional(),
    payerReference: z.string().trim().min(2).max(100),
    reason,
    validUntil: z.iso.datetime().optional(),
  })
  .refine(
    (v) => (v.decision === 'DENIED') === (v.approvedMinor === undefined || v.approvedMinor === 0),
    {
      message: 'Approvals need an approved amount; denials have none',
    },
  );
export const claimInput = z.strictObject({
  coverageId: objectId,
  invoiceIds: z.array(objectId).min(1).max(20),
  claimedMinor: z.number().int().positive(),
  preauthorizationId: objectId.optional(),
});
export const settlementInput = z.strictObject({
  expectedVersion: version,
  amountMinor: z.number().int().positive(),
  remittanceReference: z.string().trim().min(2).max(100),
});
export const withdrawInput = z.strictObject({ expectedVersion: version, reason });
export const claimQuery = z.strictObject({
  status: z
    .enum(['SUBMITTED', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'SETTLED', 'WITHDRAWN'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: objectId.optional(),
});

const who = (actor: CommandActor) => ({ kind: 'USER' as const, id: actor.userId });

// ── Payers and coverage ──────────────────────────────────────────────────────

export async function createPayer(
  actor: CommandActor,
  input: z.infer<typeof payerInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.CATALOG_MANAGE);
  return command(actor, 'platform', 'payer.create', key, input, async (session) => {
    const [row] = await Payer.create([{ ...stamp(actor.userId), ...input }], { session });
    return { id: String(row!._id), version: 0 };
  });
}

export async function listPayers() {
  const rows = await Payer.find({ status: 'ACTIVE' }).sort({ name: 1 }).limit(500).lean();
  return {
    items: rows.map((row) => ({
      id: String(row._id),
      code: row.code,
      name: row.name,
      kind: row.kind,
    })),
  };
}

async function activePayer(payerId: string) {
  if (!(await Payer.exists({ _id: payerId, status: 'ACTIVE' })))
    throw ApiError.notFound('Payer is unavailable');
}

/** A patient (or representative) records their own policy. */
export async function addCoverage(
  actor: CommandActor,
  patientId: string,
  input: z.infer<typeof coverageInput>,
  key: string,
  organizationId?: string,
) {
  if (organizationId) await authorizeOrganization(actor, organizationId, 'billing.manage');
  else await authorizePatient(actor, patientId, 'profile.update');
  await activePayer(input.payerId);
  return command(
    actor,
    organizationId ?? 'self',
    `coverage.add:${patientId}`,
    key,
    input,
    async (session) => {
      if (organizationId) {
        await scoped(actor, organizationId, 'billing.manage', session);
        if (
          !(await PatientRegistration.exists({
            organizationId,
            patientId,
            status: 'ACTIVE',
          }).session(session))
        )
          throw ApiError.notFound('Patient registration is unavailable');
      } else await authorizePatient(actor, patientId, 'profile.update', session, true);
      const [row] = await InsuranceCoverage.create(
        [
          {
            ...stamp(actor.userId),
            patientId,
            ...input,
            source: organizationId ? 'PROVIDER' : 'PATIENT',
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId,
          action: 'InsuranceCoverageAdded',
          resourceType: 'insuranceCoverage',
          resourceId: String(row!._id),
          version: 0,
        },
        session,
      );
      return { id: String(row!._id), version: 0 };
    },
  );
}

export async function patientCoverages(actor: CommandActor, patientId: string) {
  await authorizePatient(actor, patientId, 'profile.read');
  const rows = await InsuranceCoverage.find({ patientId }).sort({ _id: -1 }).limit(20).lean();
  return { items: rows.map(presentRow) };
}

async function currentCoverage(coverageId: string, patientId: string, session: ClientSession) {
  const today = todayInIndia();
  const coverage = await InsuranceCoverage.findOne({
    _id: coverageId,
    patientId,
    status: 'ACTIVE',
    validFrom: { $lte: today },
    validUntil: { $gte: today },
  }).session(session);
  if (!coverage) throw ApiError.badRequest('The policy is not current for this patient');
  return coverage;
}

// ── Pre-authorization ────────────────────────────────────────────────────────

export async function requestPreauthorization(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof preauthInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'billing.manage', {
    facilityId: input.facilityId,
  });
  return command(actor, organizationId, 'preauth.request', key, input, async (session) => {
    await scoped(actor, organizationId, 'billing.manage', session, {
      facilityId: input.facilityId,
      activeProvider: true,
    });
    const registration = await PatientRegistration.findOne({
      _id: input.patientRegistrationId,
      organizationId,
      status: 'ACTIVE',
    }).session(session);
    if (!registration) throw ApiError.notFound('Patient registration is unavailable');
    const coverage = await currentCoverage(
      input.coverageId,
      String(registration.patientId),
      session,
    );
    const [row] = await Preauthorization.create(
      [
        {
          ...stamp(actor.userId),
          organizationId,
          facilityId: input.facilityId,
          patientId: registration.patientId,
          patientRegistrationId: registration._id,
          coverageId: coverage._id,
          payerId: coverage.payerId,
          admissionId: input.admissionId,
          number: formatNumber('PA', await nextNumber(organizationId, 'PREAUTH', session)),
          treatmentSummary: input.treatmentSummary,
          requestedMinor: input.requestedMinor,
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId,
        patientId: String(registration.patientId),
        action: 'PreauthorizationSubmitted',
        resourceType: 'preauthorization',
        resourceId: String(row!._id),
        version: 0,
      },
      session,
    );
    return { id: String(row!._id), version: 0 };
  });
}

/** Records the payer's decision as received (portal, letter or integration). */
export async function recordPreauthDecision(
  actor: CommandActor,
  organizationId: string,
  preauthId: string,
  input: z.infer<typeof payerDecisionInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `preauth.decide:${preauthId}`,
    key,
    input,
    async (session) => {
      const row = await Preauthorization.findOne({
        _id: preauthId,
        organizationId,
        version: input.expectedVersion,
        status: 'SUBMITTED',
      }).session(session);
      if (!row) conflict();
      await scoped(actor, organizationId, 'billing.manage', session, {
        facilityId: String(row.facilityId),
      });
      const approved = input.approvedMinor ?? 0;
      if (approved > row.requestedMinor)
        throw ApiError.badRequest('Approval cannot exceed the requested amount');
      if (input.decision === 'APPROVED' && approved !== row.requestedMinor)
        throw ApiError.badRequest('A partial approval is recorded as PARTIALLY_APPROVED');
      row.set({
        status: input.decision,
        approvedMinor: approved,
        payerReference: input.payerReference,
        decisionReason: input.reason,
        validUntil: input.validUntil ? new Date(input.validUntil) : undefined,
        updatedBy: who(actor),
      });
      await row.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(row.patientId),
          action: 'PreauthorizationDecided',
          resourceType: 'preauthorization',
          resourceId: preauthId,
          version: row.version,
          reason: input.decision,
        },
        session,
      );
      return { id: preauthId, version: row.version };
    },
  );
}

// ── Claims ───────────────────────────────────────────────────────────────────

/**
 * Submits issued invoices of one patient to their payer. Each invoice may be on one open claim
 * only, and the claim cannot exceed the invoices' outstanding balance or an approved
 * pre-authorization.
 */
export async function submitClaim(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof claimInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'billing.manage');
  return command(actor, organizationId, 'claim.submit', key, input, async (session) => {
    const invoices = await Invoice.find({
      _id: { $in: input.invoiceIds },
      organizationId,
      status: 'ISSUED',
    }).session(session);
    if (invoices.length !== new Set(input.invoiceIds).size)
      throw ApiError.badRequest('Claims cover issued invoices of this provider only');
    const patientIds = new Set(invoices.map((row) => String(row.patientId)));
    if (patientIds.size !== 1) throw ApiError.badRequest('A claim covers one patient');
    const facilityIds = new Set(invoices.map((row) => String(row.facilityId ?? '')));
    const facilityId = [...facilityIds][0] || undefined;
    await scoped(actor, organizationId, 'billing.manage', session, {
      facilityId,
      activeProvider: true,
    });
    const patientId = [...patientIds][0]!;
    const coverage = await currentCoverage(input.coverageId, patientId, session);
    const balance = invoices.reduce((sum, row) => sum + outstanding(row), 0);
    if (input.claimedMinor > balance)
      throw ApiError.badRequest('The claim exceeds the invoices’ outstanding balance');
    if (input.preauthorizationId) {
      const preauth = await Preauthorization.findOne({
        _id: input.preauthorizationId,
        organizationId,
        patientId,
        coverageId: coverage._id,
        status: { $in: ['APPROVED', 'PARTIALLY_APPROVED'] },
      }).session(session);
      if (!preauth) throw ApiError.badRequest('Choose an approved pre-authorization');
      if (input.claimedMinor > (preauth.approvedMinor ?? 0))
        throw ApiError.badRequest('The claim exceeds the pre-authorized amount');
    }
    const registration = invoices[0]!.patientRegistrationId ?? undefined;
    const [claim] = await InsuranceClaim.create(
      [
        {
          ...stamp(actor.userId),
          organizationId,
          facilityId,
          patientId,
          patientRegistrationId: registration,
          coverageId: coverage._id,
          payerId: coverage.payerId,
          preauthorizationId: input.preauthorizationId,
          number: formatNumber('CLM', await nextNumber(organizationId, 'CLAIM', session)),
          invoiceIds: invoices.map((row) => row._id),
          claimedMinor: input.claimedMinor,
          submittedAt: new Date(),
        },
      ],
      { session },
    );
    try {
      await ClaimInvoice.create(
        invoices.map((row) => ({ organizationId, claimId: claim!._id, invoiceId: row._id })),
        { session, ordered: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        conflict('An invoice is already on an open claim');
      throw error;
    }
    await recordChange(
      actor,
      {
        organizationId,
        patientId,
        action: 'InsuranceClaimSubmitted',
        resourceType: 'insuranceClaim',
        resourceId: String(claim!._id),
        version: 0,
      },
      session,
    );
    return { id: String(claim!._id), version: 0 };
  });
}

async function claimFor(
  actor: CommandActor,
  organizationId: string,
  claimId: string,
  expectedVersion: number,
  session: ClientSession,
) {
  const claim = await InsuranceClaim.findOne({
    _id: claimId,
    organizationId,
    version: expectedVersion,
  }).session(session);
  if (!claim) conflict();
  await scoped(actor, organizationId, 'billing.manage', session, {
    facilityId: claim.facilityId ? String(claim.facilityId) : undefined,
  });
  return claim;
}

const closeClaimInvoices = (claimId: Types.ObjectId, session: ClientSession) =>
  ClaimInvoice.updateMany({ claimId, open: true }, { $set: { open: false } }, { session });

export async function adjudicateClaim(
  actor: CommandActor,
  organizationId: string,
  claimId: string,
  input: z.infer<typeof payerDecisionInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `claim.adjudicate:${claimId}`,
    key,
    input,
    async (session) => {
      const claim = await claimFor(actor, organizationId, claimId, input.expectedVersion, session);
      if (claim.status !== 'SUBMITTED') conflict('Only submitted claims are adjudicated');
      const approved = input.approvedMinor ?? 0;
      if (approved > claim.claimedMinor)
        throw ApiError.badRequest('Approval cannot exceed the claimed amount');
      if (input.decision === 'APPROVED' && approved !== claim.claimedMinor)
        throw ApiError.badRequest('A partial approval is recorded as PARTIALLY_APPROVED');
      claim.set({
        status: input.decision,
        approvedMinor: approved,
        disallowedMinor: claim.claimedMinor - approved,
        payerReference: input.payerReference,
        decisionReason: input.reason,
        adjudicatedAt: new Date(),
        updatedBy: who(actor),
      });
      await claim.save({ session });
      // A denial releases the invoices for patient collection or another claim.
      if (input.decision === 'DENIED') await closeClaimInvoices(claim._id, session);
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(claim.patientId),
          action: 'InsuranceClaimAdjudicated',
          resourceType: 'insuranceClaim',
          resourceId: claimId,
          version: claim.version,
          reason: input.decision,
        },
        session,
      );
      return { id: claimId, version: claim.version };
    },
  );
}

/**
 * Posts the payer's remittance: an INSURANCE receipt (cash/bank debit, advances credit) applied
 * to the claim's invoices oldest first. Any disallowed remainder stays on the invoice as the
 * patient's responsibility.
 */
export async function settleClaim(
  actor: CommandActor,
  organizationId: string,
  claimId: string,
  input: z.infer<typeof settlementInput>,
  key: string,
) {
  return command(actor, organizationId, `claim.settle:${claimId}`, key, input, async (session) => {
    const claim = await claimFor(actor, organizationId, claimId, input.expectedVersion, session);
    if (!['APPROVED', 'PARTIALLY_APPROVED'].includes(claim.status))
      conflict('Only approved claims are settled');
    if (input.amountMinor > (claim.approvedMinor ?? 0))
      throw ApiError.badRequest('The remittance exceeds the approved amount');
    const payer = await Payer.findById(claim.payerId).session(session);
    const receiptNumber = formatNumber(
      'RCPT',
      await nextNumber(organizationId, 'RECEIPT', session),
    );
    const [payment] = await Payment.create(
      [
        {
          organizationId,
          method: 'INSURANCE',
          status: 'CAPTURED',
          amountMinor: input.amountMinor,
          patientId: claim.patientId,
          patientRegistrationId: claim.patientRegistrationId,
          payerName: payer?.name ?? 'Insurance payer',
          capturedAt: new Date(),
          receivedBy: actor.userId,
          offlineReference: input.remittanceReference,
          receiptNumber,
          createdBy: who(actor),
          updatedBy: who(actor),
        },
      ],
      { session },
    );
    await postReceipt(actor, payment!, session);
    let remaining = input.amountMinor;
    const invoices = await Invoice.find({ _id: { $in: claim.invoiceIds }, organizationId })
      .sort({ _id: 1 })
      .session(session);
    for (const invoice of invoices) {
      if (!remaining) break;
      if (invoice.status !== 'ISSUED') continue;
      const amount = Math.min(remaining, outstanding(invoice));
      if (amount <= 0) continue;
      await allocate(actor, payment!, invoice, amount, `claim:${claimId}:${invoice._id}`, session);
      remaining -= amount;
    }
    claim.set({
      status: 'SETTLED',
      settledMinor: input.amountMinor - remaining,
      paymentId: payment!._id,
      settledAt: new Date(),
      updatedBy: who(actor),
    });
    await claim.save({ session });
    await closeClaimInvoices(claim._id, session);
    await recordChange(
      actor,
      {
        organizationId,
        patientId: String(claim.patientId),
        action: 'InsuranceClaimSettled',
        resourceType: 'insuranceClaim',
        resourceId: claimId,
        version: claim.version,
      },
      session,
    );
    return { id: claimId, version: claim.version };
  });
}

export async function withdrawClaim(
  actor: CommandActor,
  organizationId: string,
  claimId: string,
  input: z.infer<typeof withdrawInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `claim.withdraw:${claimId}`,
    key,
    input,
    async (session) => {
      const claim = await claimFor(actor, organizationId, claimId, input.expectedVersion, session);
      if (!['SUBMITTED', 'APPROVED', 'PARTIALLY_APPROVED'].includes(claim.status)) conflict();
      claim.set({ status: 'WITHDRAWN', decisionReason: input.reason, updatedBy: who(actor) });
      await claim.save({ session });
      await closeClaimInvoices(claim._id, session);
      return { id: claimId, version: claim.version };
    },
  );
}

export async function listClaims(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof claimQuery>,
) {
  await authorizeOrganization(actor, organizationId, 'billing.read');
  const rows = await InsuranceClaim.find({
    organizationId,
    ...(query.status ? { status: query.status } : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, presentRow);
}

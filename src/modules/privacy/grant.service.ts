import type { ClientSession } from 'mongoose';
import { AccessGrant, Consent, type ShareableResource } from './privacy.model.js';

/**
 * Evaluates current authority on every call: there is no grant cache to invalidate. A consent
 * grant is usable only while its consent remains active and unexpired.
 */
export async function activeGrant(
  patientId: string,
  recipient: { organizationId?: string; userId?: string },
  resourceType: ShareableResource,
  session?: ClientSession,
) {
  const now = new Date();
  const recipients = [
    ...(recipient.organizationId
      ? [{ 'recipient.kind': 'ORGANIZATION', 'recipient.id': recipient.organizationId }]
      : []),
    ...(recipient.userId ? [{ 'recipient.kind': 'USER', 'recipient.id': recipient.userId }] : []),
  ];
  if (!recipients.length) return null;
  const filter = {
    patientId,
    $or: recipients,
    resourceTypes: resourceType,
    revokedAt: { $exists: false },
    validFrom: { $lte: now },
    expiresAt: { $gt: now },
  } as unknown as Parameters<typeof AccessGrant.find>[0];
  const grants = await AccessGrant.find(filter)
    .session(session ?? null)
    .limit(20);
  for (const grant of grants) {
    if (grant.basis === 'EMERGENCY') return grant;
    const consent = await Consent.findOne({
      _id: grant.consentId,
      patientId,
      status: 'ACTIVE',
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
    }).session(session ?? null);
    if (consent) return grant;
  }
  return null;
}

/** Record-period filter a grant imposes on shared reads. */
export function periodFilter(
  grant: { recordPeriodStart?: Date | null; recordPeriodEnd?: Date | null },
  field: string,
) {
  const range: Record<string, Date> = {};
  if (grant.recordPeriodStart) range.$gte = grant.recordPeriodStart;
  if (grant.recordPeriodEnd) range.$lt = grant.recordPeriodEnd;
  return Object.keys(range).length ? { [field]: range } : {};
}

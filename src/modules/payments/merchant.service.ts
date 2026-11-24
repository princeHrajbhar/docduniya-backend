import type { ClientSession, Types } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { before, pageOf, scoped } from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';
import { authorizeOrganization } from '../access/access.service.js';
import { Membership } from '../access/access.model.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { Organization } from '../organizations/organization.model.js';
import { recordChange } from '../operations/operation.service.js';
import { MerchantAccount } from '../billing/billing.model.js';
import type { merchantDecisionInput, merchantInput } from '../billing/billing.validation.js';
import { resolveSecret, type GatewayCredentials } from './gateway.js';

export type MerchantDocument = ReturnType<typeof MerchantAccount.hydrate>;

export const credentialsFor = (merchant: {
  providerAccountId: string;
  keySecretRef: string;
}): GatewayCredentials => ({
  keyId: merchant.providerAccountId,
  keySecret: resolveSecret(merchant.keySecretRef),
});

export async function activeMerchant(
  organizationId: string | Types.ObjectId,
  session?: ClientSession,
) {
  const merchant = await MerchantAccount.findOne({ organizationId, status: 'ACTIVE' }).session(
    session ?? null,
  );
  if (!merchant)
    throw new ApiError(
      409,
      'Online payment is not enabled for this provider',
      undefined,
      'MERCHANT_UNAVAILABLE',
    );
  return merchant;
}

const present = (row: MerchantDocument) => ({
  id: String(row._id),
  organizationId: String(row.organizationId),
  provider: row.provider,
  label: row.label,
  keyId: row.providerAccountId,
  status: row.status,
  statusReason: row.statusReason,
  verifiedAt: row.verifiedAt,
  version: row.version,
});

export async function registerMerchant(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof merchantInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'merchant.manage', { organizationWide: true });
  try {
    return await command(
      actor,
      organizationId,
      'merchant.register',
      key,
      input,
      async (session) => {
        await scoped(actor, organizationId, 'merchant.manage', session, { organizationWide: true });
        const [merchant] = await MerchantAccount.create(
          [
            {
              ...stamp(actor.userId),
              organizationId,
              provider: input.provider,
              label: input.label,
              providerAccountId: input.keyId,
              keySecretRef: input.keySecretRef,
              webhookSecretRef: input.webhookSecretRef,
            },
          ],
          { session },
        );
        await recordChange(
          actor,
          {
            organizationId,
            action: 'MerchantAccountRegistered',
            resourceType: 'merchantAccount',
            resourceId: String(merchant!._id),
            version: 0,
          },
          session,
        );
        return { id: String(merchant!._id), version: 0 };
      },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) conflict('This merchant account is already registered');
    throw error;
  }
}

export async function listMerchants(actor: CommandActor, organizationId: string, page: Pagination) {
  await authorizeOrganization(actor, organizationId, 'merchant.manage', { organizationWide: true });
  const rows = await MerchantAccount.find({ organizationId, ...before(page.before) })
    .sort({ _id: -1 })
    .limit(page.limit + 1);
  return pageOf(rows, page.limit, (row) => present(row));
}

export async function listMerchantReviews(actor: CommandActor, page: Pagination) {
  await requirePlatformPermission(actor, PERMISSIONS.MERCHANTS_VERIFY);
  const rows = await MerchantAccount.find({ status: 'PENDING', ...before(page.before) })
    .sort({ _id: -1 })
    .limit(page.limit + 1);
  return pageOf(rows, page.limit, (row) => present(row));
}

/** Independent platform activation. A provider's own staff cannot activate its merchant. */
export async function decideMerchant(
  actor: CommandActor,
  merchantId: string,
  input: z.infer<typeof merchantDecisionInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.MERCHANTS_VERIFY);
  try {
    return await command(
      actor,
      'platform',
      `merchant.decide:${merchantId}`,
      key,
      input,
      async (session) => {
        const merchant = await MerchantAccount.findOne({
          _id: merchantId,
          version: input.expectedVersion,
        }).session(session);
        if (!merchant) conflict();
        const colleague = await Membership.exists({
          organizationId: merchant.organizationId,
          userId: actor.userId,
          status: { $in: ['ACTIVE', 'SUSPENDED', 'INVITED'] },
        }).session(session);
        if (colleague) throw ApiError.forbidden('An independent reviewer is required');
        if (merchant.status === 'CLOSED') conflict('Closed merchant accounts cannot change');
        if (input.status === 'ACTIVE') {
          const organization = await Organization.findOne({
            _id: merchant.organizationId,
            status: 'ACTIVE',
          }).session(session);
          if (!organization) conflict('The provider must be verified first');
          // Fails closed when the deployment lacks the referenced secrets.
          resolveSecret(merchant.keySecretRef);
          resolveSecret(merchant.webhookSecretRef);
          merchant.verifiedAt = new Date();
          merchant.set('verifiedBy', actor.userId);
        }
        merchant.status = input.status;
        merchant.statusReason = input.reason;
        merchant.updatedBy = { kind: 'USER', id: actor.userId };
        await merchant.save({ session });
        await recordChange(
          actor,
          {
            organizationId: String(merchant.organizationId),
            action: `MerchantAccount.${input.status}`,
            resourceType: 'merchantAccount',
            resourceId: merchantId,
            version: merchant.version,
            reason: input.reason,
          },
          session,
        );
        return { id: merchantId, version: merchant.version };
      },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) conflict('The provider already has an active merchant account');
    throw error;
  }
}

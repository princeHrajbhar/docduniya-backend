import { Schema, model } from 'mongoose';
import { metadataFields, aggregateOptions, ref, bounded } from '../../shared/persistence/schema.js';
import { ORG_PERMISSIONS } from './access.constants.js';

const roleSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    scopeKey: { type: String, required: true },
    slug: { type: String, required: true },
    name: { type: String, required: true },
    permissionCodes: {
      type: [{ type: String, enum: ORG_PERMISSIONS }],
      required: true,
      validate: bounded(200),
    },
    system: { type: Boolean, default: true },
    status: { type: String, enum: ['ACTIVE', 'RETIRED'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
roleSchema.index({ scopeKey: 1, slug: 1 }, { unique: true });
export const ScopedRole = model('ScopedRole', roleSchema, 'roles');

const membershipSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    userId: ref('User'),
    invitedBy: ref('User'),
    status: { type: String, enum: ['INVITED', 'ACTIVE', 'SUSPENDED', 'ENDED'], required: true },
    facilityScope: { type: String, enum: ['ALL', 'SELECTED'], required: true },
    facilityIds: { type: [Schema.Types.ObjectId], default: [], validate: bounded(100) },
    validFrom: { type: Date, required: true },
    validUntil: Date,
    invitationExpiresAt: Date,
    authorizationFence: { type: Number, default: 0 },
  },
  aggregateOptions,
);
membershipSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1, status: 1 });
export const Membership = model('Membership', membershipSchema, 'memberships');

const assignmentSchema = new Schema(
  {
    ...metadataFields,
    userId: ref('User'),
    organizationId: ref('Organization'),
    membershipId: ref('Membership'),
    roleId: ref('ScopedRole'),
    scopeKey: { type: String, required: true },
    validFrom: { type: Date, required: true },
    validUntil: Date,
    revokedAt: Date,
  },
  aggregateOptions,
);
assignmentSchema.index(
  { userId: 1, roleId: 1, scopeKey: 1 },
  { unique: true, partialFilterExpression: { revokedAt: null } },
);
assignmentSchema.index({ organizationId: 1, membershipId: 1 });
export const RoleAssignment = model('RoleAssignment', assignmentSchema, 'roleAssignments');

import { Types, type ClientSession, type InferSchemaType } from 'mongoose';
import type { z } from 'zod';
import { Patient, PatientRelationship, PatientRegistration } from './patient.model.js';
import type {
  createPatientInput,
  updatePatientInput,
  registrationInput,
  selfRegistrationInput,
  relationshipDecisionInput,
  revokeRelationshipInput,
  registrationQuery,
  updateRegistrationInput,
} from './patient.validation.js';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { authorizeOrganization, lockMembership } from '../access/access.service.js';
import {
  lockActiveFacility,
  organizationForScope,
} from '../organizations/organization.repository.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { recordChange, recordRead, nextMrn } from '../operations/operation.service.js';

type PatientAction = 'profile.read' | 'profile.update' | 'registration.create';
export async function authorizePatient(
  actor: CommandActor,
  patientId: string,
  action: PatientAction,
  session?: ClientSession,
  lock = false,
) {
  const patient = await Patient.findOne({
    _id: patientId,
    status: { $in: ['ACTIVE', 'TEMPORARY'] },
  }).session(session ?? null);
  if (!patient) throw ApiError.notFound('Patient is unavailable');
  if (String(patient.ownerUserId) !== actor.userId) {
    const now = new Date();
    const relationship = await PatientRelationship.findOne({
      patientId,
      relatedUserId: actor.userId,
      status: 'ACTIVE',
      allowedActions: action,
      validFrom: { $lte: now },
      $or: [{ validUntil: { $exists: false } }, { validUntil: { $gt: now } }],
    }).session(session ?? null);
    if (!relationship) throw ApiError.notFound('Patient is unavailable');
    if (session && lock)
      await PatientRelationship.updateOne(
        { _id: relationship._id, status: 'ACTIVE' },
        { $inc: { authorizationFence: 1 } },
        { session },
      );
  }
  if (session && lock)
    await Patient.updateOne({ _id: patientId }, { $inc: { authorizationFence: 1 } }, { session });
  return patient;
}
export function patientDemographics(patient: InferSchemaType<typeof Patient.schema>) {
  return {
    name: patient.name,
    birthDate: patient.birthDate,
    administrativeSex: patient.administrativeSex,
    preferredLanguage: patient.preferredLanguage,
    addresses: patient.addresses,
    contacts: patient.contacts,
    emergencyContacts: patient.emergencyContacts,
  };
}
export async function createPatient(
  actor: CommandActor,
  input: z.infer<typeof createPatientInput>,
  key: string,
) {
  return command(actor, 'self', 'patient.create', key, input, async (session) => {
    const [patient] = await Patient.create(
      [
        {
          ...input.profile,
          ...stamp(actor.userId),
          ownerUserId: input.kind === 'SELF' ? actor.userId : undefined,
          birthDatePrecision: input.profile.birthDate ? 'EXACT' : 'UNKNOWN',
        },
      ],
      { session },
    );
    const id = String(patient!._id);
    if (input.kind === 'DEPENDENT')
      await PatientRelationship.create(
        [
          {
            ...stamp(actor.userId),
            patientId: id,
            relatedUserId: actor.userId,
            relationship: input.relationship,
            authorityReference: input.authorityReference,
            allowedActions: ['profile.read', 'profile.update', 'registration.create'],
            status: 'PENDING',
          },
        ],
        { session },
      );
    await recordChange(
      actor,
      {
        patientId: id,
        action: 'PatientCreated',
        resourceType: 'patient',
        resourceId: id,
        version: 0,
      },
      session,
    );
    return { id, version: 0 };
  });
}
export async function getPatient(actor: CommandActor, patientId: string) {
  const patient = await authorizePatient(actor, patientId, 'profile.read');
  await recordRead(actor, 'patient', patientId, undefined, patientId);
  return {
    id: patientId,
    ...patientDemographics(patient),
    birthDatePrecision: patient.birthDatePrecision,
    status: patient.status,
    version: patient.version,
  };
}
export async function updatePatient(
  actor: CommandActor,
  patientId: string,
  input: z.infer<typeof updatePatientInput>,
  key: string,
) {
  await authorizePatient(actor, patientId, 'profile.update');
  return command(actor, 'self', `patient.update:${patientId}`, key, input, async (session) => {
    await authorizePatient(actor, patientId, 'profile.update', session, true);
    const updated = await Patient.findOneAndUpdate(
      { _id: patientId, version: input.expectedVersion },
      {
        $set: {
          ...input.profile,
          birthDatePrecision: input.profile.birthDate ? 'EXACT' : 'UNKNOWN',
          updatedBy: { kind: 'USER', id: actor.userId },
        },
        ...(input.profile.birthDate ? {} : { $unset: { birthDate: 1 } }),
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after', runValidators: true },
    );
    if (!updated) conflict();
    await recordChange(
      actor,
      {
        patientId,
        action: 'PatientProfileUpdated',
        resourceType: 'patient',
        resourceId: patientId,
        version: updated.version,
      },
      session,
    );
    return { id: patientId, version: updated.version };
  });
}
export async function listOwnPatients(actor: CommandActor, page: Pagination) {
  const now = new Date();
  const relations = await PatientRelationship.find({
    relatedUserId: actor.userId,
    status: 'ACTIVE',
    allowedActions: 'profile.read',
    validFrom: { $lte: now },
    $or: [{ validUntil: { $exists: false } }, { validUntil: { $gt: now } }],
  }).distinct('patientId');
  const rows = await Patient.find({
    $or: [{ ownerUserId: actor.userId }, { _id: { $in: relations } }],
    ...(page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {}),
    status: { $in: ['ACTIVE', 'TEMPORARY'] },
  })
    .select('name status version')
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  for (const row of rows.slice(0, page.limit))
    await recordRead(actor, 'patient', String(row._id), undefined, String(row._id));
  return {
    items: rows.slice(0, page.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row })),
    nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!._id) : undefined,
  };
}
export async function listOwnRelationships(actor: CommandActor, page: Pagination) {
  const rows = await PatientRelationship.find({
    relatedUserId: actor.userId,
    ...(page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {}),
  })
    .select('patientId relationship status validFrom validUntil version')
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return {
    items: rows.slice(0, page.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row })),
    nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!._id) : undefined,
  };
}
export async function decideRelationship(
  actor: CommandActor,
  relationshipId: string,
  input: z.infer<typeof relationshipDecisionInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.PATIENT_RELATIONSHIPS_VERIFY);
  return command(
    actor,
    'platform',
    `relationship.decide:${relationshipId}`,
    key,
    input,
    async (session) => {
      const relation = await PatientRelationship.findOne({
        _id: relationshipId,
        status: 'PENDING',
        version: input.expectedVersion,
      }).session(session);
      if (!relation) conflict('Relationship request is no longer pending');
      if (String(relation.relatedUserId) === actor.userId)
        throw ApiError.forbidden('An independent reviewer must verify representative authority');
      if (
        input.decision === 'ACTIVE' &&
        (!input.validUntil || new Date(input.validUntil) <= new Date())
      )
        throw ApiError.badRequest(
          'Active representative authority requires a future review/expiry date',
        );
      relation.status = input.decision;
      relation.validFrom = new Date();
      relation.validUntil = input.validUntil ? new Date(input.validUntil) : undefined;
      relation.verifiedBy = new Types.ObjectId(actor.userId);
      relation.verifiedAt = new Date();
      relation.decisionReason = input.reason;
      relation.updatedBy = { kind: 'USER', id: actor.userId };
      await relation.save({ session });
      await recordChange(
        actor,
        {
          patientId: String(relation.patientId),
          action: 'PatientRelationshipReviewed',
          resourceType: 'patientRelationship',
          resourceId: relationshipId,
          version: relation.version,
          reason: input.reason,
        },
        session,
      );
      return { id: relationshipId, version: relation.version };
    },
  );
}
export async function listRelationshipRequests(actor: CommandActor, page: Pagination) {
  await requirePlatformPermission(actor, PERMISSIONS.PATIENT_RELATIONSHIPS_VERIFY);
  const rows = await PatientRelationship.find({
    status: 'PENDING',
    ...(page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {}),
  })
    .select('patientId relatedUserId relationship authorityReference status version')
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  for (const row of rows.slice(0, page.limit))
    await recordRead(
      actor,
      'patientRelationship',
      String(row._id),
      undefined,
      String(row.patientId),
    );
  return {
    items: rows.slice(0, page.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row })),
    nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!._id) : undefined,
  };
}
export async function revokeRelationship(
  actor: CommandActor,
  relationshipId: string,
  input: z.infer<typeof revokeRelationshipInput>,
  key: string,
) {
  return command(
    actor,
    'self',
    `relationship.revoke:${relationshipId}`,
    key,
    input,
    async (session) => {
      const relation = await PatientRelationship.findOne({
        _id: relationshipId,
        version: input.expectedVersion,
      }).session(session);
      if (!relation) throw ApiError.notFound();
      const patient = await Patient.findById(relation.patientId).session(session);
      if (
        String(relation.relatedUserId) !== actor.userId &&
        String(patient?.ownerUserId) !== actor.userId
      )
        throw ApiError.notFound();
      relation.status = 'REVOKED';
      relation.updatedBy = { kind: 'USER', id: actor.userId };
      await relation.save({ session });
      await recordChange(
        actor,
        {
          patientId: String(relation.patientId),
          action: 'PatientRelationshipRevoked',
          resourceType: 'patientRelationship',
          resourceId: relationshipId,
          version: relation.version,
          reason: input.reason,
        },
        session,
      );
      return { id: relationshipId, version: relation.version };
    },
  );
}
export async function createProviderRegistration(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof registrationInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'patients.register', {
    facilityId: input.facilityId,
    activeProvider: true,
  });
  return command(actor, organizationId, 'registration.create', key, input, async (session) => {
    const scope = await authorizeOrganization(actor, organizationId, 'patients.register', {
      session,
      facilityId: input.facilityId,
      activeProvider: true,
    });
    await lockMembership(scope.membership._id, session);
    await lockActiveFacility(organizationId, input.facilityId, session);
    const [patient] = await Patient.create(
      [
        {
          ...input.profile,
          ...stamp(actor.userId),
          birthDatePrecision: input.profile.birthDate ? 'EXACT' : 'UNKNOWN',
        },
      ],
      { session },
    );
    const patientId = String(patient!._id);
    const [registration] = await PatientRegistration.create(
      [
        {
          ...stamp(actor.userId),
          organizationId,
          patientId,
          primaryFacilityId: input.facilityId,
          mrn: await nextMrn(organizationId, session),
          demographicSnapshot: input.profile,
        },
      ],
      { session },
    );
    const id = String(registration!._id);
    await recordChange(
      actor,
      {
        organizationId,
        patientId,
        action: 'PatientRegistered',
        resourceType: 'patientRegistration',
        resourceId: id,
        version: 0,
      },
      session,
    );
    return { id, version: 0 };
  });
}
export async function registerSelfAtProvider(
  actor: CommandActor,
  patientId: string,
  input: z.infer<typeof selfRegistrationInput>,
  key: string,
) {
  await authorizePatient(actor, patientId, 'registration.create');
  return command(
    actor,
    input.organizationId,
    `registration.self:${patientId}`,
    key,
    input,
    async (session) => {
      const patient = await authorizePatient(
        actor,
        patientId,
        'registration.create',
        session,
        true,
      );
      const organization = await organizationForScope(input.organizationId, session);
      if (organization.status !== 'ACTIVE') throw ApiError.notFound('Provider is unavailable');
      await lockActiveFacility(input.organizationId, input.facilityId, session);
      const existing = await PatientRegistration.findOne({
        organizationId: input.organizationId,
        patientId,
      }).session(session);
      if (existing) return { id: String(existing._id), version: existing.version };
      const [registration] = await PatientRegistration.create(
        [
          {
            ...stamp(actor.userId),
            organizationId: input.organizationId,
            patientId,
            primaryFacilityId: input.facilityId,
            mrn: await nextMrn(input.organizationId, session),
            demographicSnapshot: patientDemographics(patient),
          },
        ],
        { session },
      );
      const id = String(registration!._id);
      await recordChange(
        actor,
        {
          organizationId: input.organizationId,
          patientId,
          action: 'PatientSelfRegistered',
          resourceType: 'patientRegistration',
          resourceId: id,
          version: 0,
        },
        session,
      );
      return { id, version: 0 };
    },
  );
}
export async function getRegistration(
  actor: CommandActor,
  organizationId: string,
  registrationId: string,
) {
  await authorizeOrganization(actor, organizationId, 'patients.demographics.read', {
    activeProvider: true,
  });
  const row = await PatientRegistration.findOne({ _id: registrationId, organizationId }).lean();
  if (!row) throw ApiError.notFound();
  await authorizeOrganization(actor, organizationId, 'patients.demographics.read', {
    facilityId: String(row.primaryFacilityId),
    activeProvider: true,
  });
  await recordRead(
    actor,
    'patientRegistration',
    registrationId,
    organizationId,
    String(row.patientId),
  );
  return {
    id: registrationId,
    patientId: String(row.patientId),
    mrn: row.mrn,
    primaryFacilityId: String(row.primaryFacilityId),
    profile: row.demographicSnapshot,
    status: row.status,
    version: row.version,
  };
}

export async function listRegistrations(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof registrationQuery>,
) {
  const { membership } = await authorizeOrganization(
    actor,
    organizationId,
    'patients.demographics.read',
    { activeProvider: true },
  );
  const rows = await PatientRegistration.find({
    organizationId,
    status: 'ACTIVE',
    ...(membership.facilityScope === 'SELECTED'
      ? { primaryFacilityId: { $in: membership.facilityIds } }
      : {}),
    ...(query.before ? { _id: { $lt: new Types.ObjectId(query.before) } } : {}),
    ...(query.mrn ? { mrn: query.mrn } : {}),
  })
    .select('patientId mrn primaryFacilityId demographicSnapshot.name status version')
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  for (const row of rows.slice(0, query.limit))
    await recordRead(
      actor,
      'patientRegistration',
      String(row._id),
      organizationId,
      String(row.patientId),
    );
  return {
    items: rows.slice(0, query.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row })),
    nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]!._id) : undefined,
  };
}

export async function updateRegistration(
  actor: CommandActor,
  organizationId: string,
  registrationId: string,
  input: z.infer<typeof updateRegistrationInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'patients.demographics.update', {
    activeProvider: true,
  });
  return command(
    actor,
    organizationId,
    `registration.update:${registrationId}`,
    key,
    input,
    async (session) => {
      const registration = await PatientRegistration.findOne({
        _id: registrationId,
        organizationId,
        status: 'ACTIVE',
      }).session(session);
      if (!registration) throw ApiError.notFound();
      const { membership } = await authorizeOrganization(
        actor,
        organizationId,
        'patients.demographics.update',
        { session, activeProvider: true, facilityId: String(registration.primaryFacilityId) },
      );
      if (registration.version !== input.expectedVersion) conflict();
      await lockMembership(membership._id, session);
      await lockActiveFacility(organizationId, String(registration.primaryFacilityId), session);
      registration.set('demographicSnapshot', input.profile);
      registration.updatedBy = { kind: 'USER', id: actor.userId };
      await registration.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(registration.patientId),
          action: 'PatientRegistrationCorrected',
          resourceType: 'patientRegistration',
          resourceId: registrationId,
          version: registration.version,
          reason: input.reason,
        },
        session,
      );
      return { id: registrationId, version: registration.version };
    },
  );
}

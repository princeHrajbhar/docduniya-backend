import { Types, type ClientSession } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { recordChange, recordRead } from '../operations/operation.service.js';
import {
  Practitioner,
  Doctor,
  PractitionerQualification,
  PractitionerEmployment,
  ProfessionalRegistration,
  Specialty,
} from './practitioner.model.js';
import type {
  practitionerInput,
  doctorInput,
  qualificationInput,
  employmentInput,
  professionalRegistrationInput,
  updatePractitionerInput,
  updateDoctorInput,
} from './practitioner.validation.js';

async function ownPractitioner(actor: CommandActor, session?: ClientSession) {
  const practitioner = await Practitioner.findOne({
    userId: actor.userId,
    status: 'ACTIVE',
  }).session(session ?? null);
  if (!practitioner) throw ApiError.notFound('Create an active practitioner profile first');
  return practitioner;
}
export async function createPractitioner(
  actor: CommandActor,
  input: z.infer<typeof practitionerInput>,
  key: string,
) {
  return command(actor, 'self', 'practitioner.create', key, input, async (session) => {
    const [practitioner] = await Practitioner.create(
      [{ ...input, ...stamp(actor.userId), userId: actor.userId }],
      { session },
    );
    const id = String(practitioner!._id);
    await recordChange(
      actor,
      { action: 'PractitionerCreated', resourceType: 'practitioner', resourceId: id, version: 0 },
      session,
    );
    return { id, version: 0 };
  });
}
export async function getPractitioner(actor: CommandActor) {
  const practitioner = await ownPractitioner(actor);
  await recordRead(actor, 'practitioner', String(practitioner._id));
  return {
    id: String(practitioner._id),
    name: practitioner.name,
    profession: practitioner.profession,
    birthDate: practitioner.birthDate,
    contacts: practitioner.contacts,
    residentialAddresses: practitioner.residentialAddresses,
    languages: practitioner.languages,
    status: practitioner.status,
    version: practitioner.version,
  };
}
export async function createDoctor(
  actor: CommandActor,
  input: z.infer<typeof doctorInput>,
  key: string,
) {
  return command(actor, 'self', 'doctor.create', key, input, async (session) => {
    const practitioner = await ownPractitioner(actor, session);
    if (practitioner.profession !== 'DOCTOR')
      throw ApiError.forbidden('Doctor profiles require the doctor profession');
    const count = await Specialty.countDocuments({
      _id: { $in: input.specialtyIds },
      status: 'ACTIVE',
    }).session(session);
    if (
      new Set(input.specialtyIds).size !== input.specialtyIds.length ||
      count !== input.specialtyIds.length
    )
      throw ApiError.badRequest('Choose valid, distinct specialties');
    const [doctor] = await Doctor.create(
      [{ ...input, ...stamp(actor.userId), practitionerId: practitioner._id }],
      { session },
    );
    const id = String(doctor!._id);
    await recordChange(
      actor,
      { action: 'DoctorProfileCreated', resourceType: 'doctor', resourceId: id, version: 0 },
      session,
    );
    return { id, version: 0 };
  });
}
export async function getDoctor(actor: CommandActor) {
  const practitioner = await ownPractitioner(actor);
  const doctor = await Doctor.findOne({ practitionerId: practitioner._id })
    .select(
      'slug publicName bio specialtyIds careerStartDate verificationStatus verificationCaseId verifiedUntil profilePublished version',
    )
    .lean();
  if (!doctor) throw ApiError.notFound('Doctor profile not found');
  return { ...doctor, id: String(doctor._id), _id: undefined };
}

export async function updatePractitioner(
  actor: CommandActor,
  input: z.infer<typeof updatePractitionerInput>,
  key: string,
) {
  return command(actor, 'self', 'practitioner.update', key, input, async (session) => {
    const practitioner = await ownPractitioner(actor, session);
    if (practitioner.version !== input.expectedVersion) conflict();
    if (practitioner.profession !== input.profile.profession)
      throw ApiError.badRequest('Profession changes require a separate review');
    const doctor = await Doctor.findOne({ practitionerId: practitioner._id }).session(session);
    if (doctor) {
      const nameFields = ['display', 'given', 'middle', 'family', 'prefix', 'native'] as const;
      const identityChanged =
        nameFields.some((field) => practitioner.name[field] !== input.profile.name[field]) ||
        practitioner.birthDate !== input.profile.birthDate;
      if (identityChanged && doctor.verificationStatus !== 'UNVERIFIED')
        conflict('Withdraw verification before changing professional identity');
      // Serialize identity edits with submission/review without changing the public revision.
      await Doctor.updateOne({ _id: doctor._id }, { $inc: { authorizationFence: 1 } }, { session });
    }
    practitioner.set({ ...input.profile, birthDate: input.profile.birthDate });
    practitioner.updatedBy = { kind: 'USER', id: actor.userId };
    await practitioner.save({ session });
    const id = String(practitioner._id);
    await recordChange(
      actor,
      {
        action: 'PractitionerUpdated',
        resourceType: 'practitioner',
        resourceId: id,
        version: practitioner.version,
      },
      session,
    );
    return { id, version: practitioner.version };
  });
}

export async function updateDoctor(
  actor: CommandActor,
  input: z.infer<typeof updateDoctorInput>,
  key: string,
) {
  return command(actor, 'self', 'doctor.update', key, input, async (session) => {
    const practitioner = await ownPractitioner(actor, session);
    const doctor = await Doctor.findOne({
      practitionerId: practitioner._id,
      verificationStatus: 'UNVERIFIED',
      version: input.expectedVersion,
    }).session(session);
    if (!doctor) conflict('Only a current unverified draft can be edited');
    const count = await Specialty.countDocuments({
      _id: { $in: input.profile.specialtyIds },
      status: 'ACTIVE',
    }).session(session);
    if (count !== input.profile.specialtyIds.length)
      throw ApiError.badRequest('Choose valid, distinct specialties');
    doctor.set({ ...input.profile, careerStartDate: input.profile.careerStartDate });
    doctor.updatedBy = { kind: 'USER', id: actor.userId };
    await doctor.save({ session });
    const id = String(doctor._id);
    await recordChange(
      actor,
      {
        action: 'DoctorDraftUpdated',
        resourceType: 'doctor',
        resourceId: id,
        version: doctor.version,
      },
      session,
    );
    return { id, version: doctor.version };
  });
}

type CredentialKind = 'qualifications' | 'employment' | 'registrations';
type CredentialInput =
  | z.infer<typeof qualificationInput>
  | z.infer<typeof employmentInput>
  | z.infer<typeof professionalRegistrationInput>;
export async function addCredential(
  actor: CommandActor,
  kind: CredentialKind,
  input: CredentialInput,
  key: string,
) {
  return command(actor, 'self', `practitioner.${kind}.create`, key, input, async (session) => {
    const practitioner = await ownPractitioner(actor, session);
    const fields = { ...input, ...stamp(actor.userId), practitionerId: practitioner._id };
    // Each route validates its own strict DTO; individual models retain independent lifecycles.
    let id: string;
    if (kind === 'qualifications') {
      const [row] = await PractitionerQualification.create([fields], { session });
      id = String(row!._id);
    } else if (kind === 'employment') {
      const [row] = await PractitionerEmployment.create([fields], { session });
      id = String(row!._id);
    } else {
      const [row] = await ProfessionalRegistration.create([fields], { session });
      id = String(row!._id);
    }
    await recordChange(
      actor,
      { action: `Practitioner${kind}Declared`, resourceType: kind, resourceId: id, version: 0 },
      session,
    );
    return { id, version: 0 };
  });
}
export async function listCredentials(actor: CommandActor, kind: CredentialKind, page: Pagination) {
  const practitioner = await ownPractitioner(actor);
  const filter = {
    practitionerId: practitioner._id,
    ...(page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {}),
  };
  const rows =
    kind === 'qualifications'
      ? await PractitionerQualification.find(filter)
          .sort({ _id: -1 })
          .limit(page.limit + 1)
          .lean()
      : kind === 'employment'
        ? await PractitionerEmployment.find(filter)
            .sort({ _id: -1 })
            .limit(page.limit + 1)
            .lean()
        : await ProfessionalRegistration.find(filter)
            .sort({ _id: -1 })
            .limit(page.limit + 1)
            .lean();
  await recordRead(actor, `practitioner.${kind}`, String(practitioner._id));
  return {
    items: rows.slice(0, page.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row })),
    nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!._id) : undefined,
  };
}
export async function listSpecialties(page: Pagination) {
  const rows = await Specialty.find({
    status: 'ACTIVE',
    ...(page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {}),
  })
    .select('code name')
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return {
    items: rows.slice(0, page.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row })),
    nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!._id) : undefined,
  };
}

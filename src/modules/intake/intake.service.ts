import { createHash } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { canonical, command, conflict } from '../../shared/application/command.js';
import { before, pageOf, presentRow, scoped } from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { authorizeOrganization } from '../access/access.service.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { authorizePatient } from '../patients/patient.service.js';
import { recordChange, recordRead } from '../operations/operation.service.js';
import { Appointment } from '../appointments/appointment.model.js';
import { ServiceOffering } from '../scheduling/scheduling.model.js';
import { Practitioner, Specialty } from '../practitioners/practitioner.model.js';
import { authorizeClinical } from '../clinical/clinical.policy.js';
import {
  ConcernMapping,
  IntakeResponse,
  Questionnaire,
  QuestionnaireAssignment,
} from './intake.model.js';
import type {
  answerInput,
  assignmentInput,
  concernInput,
  concernSearch,
  intakeSubmission,
  questionnaireInput,
  questionnaireQuery,
  routeInput,
} from './intake.validation.js';

type QuestionnaireInput = z.infer<typeof questionnaireInput>;
type QuestionnaireRow = ReturnType<typeof Questionnaire.hydrate>;
const who = (actor: CommandActor) => ({ kind: 'USER' as const, id: actor.userId });

// ── Questionnaire authoring ──────────────────────────────────────────────────

/** Platform templates need catalog authority; provider questionnaires need services.manage. */
async function authorizeAuthoring(
  actor: CommandActor,
  organizationId: string | undefined,
  session?: ClientSession,
) {
  if (!organizationId) {
    await requirePlatformPermission(actor, PERMISSIONS.CATALOG_MANAGE);
    return 'platform';
  }
  if (session)
    await scoped(actor, organizationId, 'services.manage', session, { activeProvider: true });
  else await authorizeOrganization(actor, organizationId, 'services.manage');
  return `org:${organizationId}`;
}

async function questionnaireFor(
  actor: CommandActor,
  organizationId: string | undefined,
  id: string,
  session?: ClientSession,
) {
  const scopeKey = await authorizeAuthoring(actor, organizationId, session);
  const row = await Questionnaire.findOne({ _id: id, scopeKey }).session(session ?? null);
  if (!row) throw ApiError.notFound();
  return row;
}

export async function createQuestionnaire(
  actor: CommandActor,
  organizationId: string | undefined,
  input: QuestionnaireInput,
  key: string,
) {
  await authorizeAuthoring(actor, organizationId);
  return command(
    actor,
    organizationId ?? 'platform',
    'questionnaire.create',
    key,
    input,
    async (session) => {
      const scopeKey = await authorizeAuthoring(actor, organizationId, session);
      const latest = await Questionnaire.findOne({ scopeKey, code: input.code })
        .sort({ questionnaireVersion: -1 })
        .session(session);
      if (latest?.status === 'DRAFT') conflict('A draft of this questionnaire already exists');
      const [row] = await Questionnaire.create(
        [
          {
            ...stamp(actor.userId),
            scopeKey,
            organizationId,
            ...input,
            questionnaireVersion: (latest?.questionnaireVersion ?? 0) + 1,
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          action: 'QuestionnaireDrafted',
          resourceType: 'questionnaire',
          resourceId: String(row!._id),
          version: 0,
        },
        session,
      );
      return { id: String(row!._id), version: 0 };
    },
  );
}

export async function updateQuestionnaireDraft(
  actor: CommandActor,
  organizationId: string | undefined,
  id: string,
  expectedVersion: number,
  input: QuestionnaireInput,
  key: string,
) {
  return command(
    actor,
    organizationId ?? 'platform',
    `questionnaire.update:${id}`,
    key,
    { expectedVersion, input },
    async (session) => {
      const row = await questionnaireFor(actor, organizationId, id, session);
      if (row.version !== expectedVersion) conflict();
      if (row.status !== 'DRAFT') conflict('Published questionnaires change by a new version');
      if (row.code !== input.code) throw ApiError.badRequest('The questionnaire code is fixed');
      row.set({ ...input, updatedBy: who(actor) });
      await row.save({ session });
      return { id, version: row.version };
    },
  );
}

const contentHash = (row: QuestionnaireRow) =>
  createHash('sha256')
    .update(
      canonical({
        code: row.code,
        version: row.questionnaireVersion,
        title: row.title,
        language: row.language,
        items: row.toObject().items,
      }),
    )
    .digest('hex');

/** Publishing seals the content hash; answers always reference the exact version shown. */
export async function changeQuestionnaireState(
  actor: CommandActor,
  organizationId: string | undefined,
  id: string,
  expectedVersion: number,
  target: 'PUBLISHED' | 'RETIRED',
  key: string,
) {
  return command(
    actor,
    organizationId ?? 'platform',
    `questionnaire.${target.toLowerCase()}:${id}`,
    key,
    { expectedVersion },
    async (session) => {
      const row = await questionnaireFor(actor, organizationId, id, session);
      if (row.version !== expectedVersion) conflict();
      if (target === 'PUBLISHED') {
        if (row.status !== 'DRAFT') conflict('Only drafts can be published');
        row.contentHash = contentHash(row);
        row.publishedAt = new Date();
      } else if (row.status !== 'PUBLISHED') conflict('Only published questionnaires retire');
      row.status = target;
      row.updatedBy = who(actor);
      await row.save({ session });
      if (target === 'RETIRED')
        await QuestionnaireAssignment.updateMany(
          { questionnaireId: row._id, status: 'ACTIVE' },
          { $set: { status: 'ENDED', updatedBy: who(actor) }, $inc: { version: 1 } },
          { session },
        );
      await recordChange(
        actor,
        {
          organizationId,
          action: target === 'PUBLISHED' ? 'QuestionnairePublished' : 'QuestionnaireRetired',
          resourceType: 'questionnaire',
          resourceId: id,
          version: row.version,
        },
        session,
      );
      return { id, version: row.version };
    },
  );
}

export async function listQuestionnaires(
  actor: CommandActor,
  organizationId: string | undefined,
  query: z.infer<typeof questionnaireQuery>,
) {
  const scopeKey = await authorizeAuthoring(actor, organizationId);
  const rows = await Questionnaire.find({
    scopeKey: organizationId ? { $in: [scopeKey, 'platform'] } : scopeKey,
    ...(query.status ? { status: query.status } : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, presentRow);
}

/** Attaches a published questionnaire (the provider's own or a platform template) to an offering. */
export async function assignQuestionnaire(
  actor: CommandActor,
  organizationId: string,
  offeringId: string,
  input: z.infer<typeof assignmentInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `questionnaire.assign:${offeringId}`,
    key,
    input,
    async (session) => {
      const offering = await ServiceOffering.findOne({ _id: offeringId, organizationId }).session(
        session,
      );
      if (!offering) throw ApiError.notFound('Service is unavailable');
      await scoped(actor, organizationId, 'services.manage', session, {
        facilityId: String(offering.facilityId),
      });
      const questionnaire = await Questionnaire.findOne({
        _id: input.questionnaireId,
        status: 'PUBLISHED',
        scopeKey: { $in: [`org:${organizationId}`, 'platform'] },
      }).session(session);
      if (!questionnaire) throw ApiError.notFound('Choose a published questionnaire');
      await QuestionnaireAssignment.updateMany(
        { offeringId, status: 'ACTIVE' },
        { $set: { status: 'ENDED', updatedBy: who(actor) }, $inc: { version: 1 } },
        { session },
      );
      const [row] = await QuestionnaireAssignment.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            offeringId,
            questionnaireId: questionnaire._id,
            required: input.required,
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          action: 'QuestionnaireAssigned',
          resourceType: 'serviceOffering',
          resourceId: offeringId,
          version: offering.version,
        },
        session,
      );
      return { id: String(row!._id), version: 0 };
    },
  );
}

const presentQuestionnaire = (row: QuestionnaireRow) => ({
  id: String(row._id),
  code: row.code,
  version: row.questionnaireVersion,
  title: row.title,
  description: row.description,
  language: row.language,
  items: row.toObject().items,
});

/** Public: the questions a patient will be asked for this service. */
export async function offeringQuestionnaire(offeringId: string) {
  const assignment = await QuestionnaireAssignment.findOne({ offeringId, status: 'ACTIVE' });
  if (!assignment) return { required: false, questionnaire: null };
  const questionnaire = await Questionnaire.findOne({
    _id: assignment.questionnaireId,
    status: 'PUBLISHED',
  });
  if (!questionnaire) return { required: false, questionnaire: null };
  return { required: assignment.required, questionnaire: presentQuestionnaire(questionnaire) };
}

// ── Answers ──────────────────────────────────────────────────────────────────

type Answer = z.infer<typeof answerInput>;
const answerText = (answer?: Answer) =>
  answer === undefined
    ? undefined
    : answer.valueBoolean !== undefined
      ? String(answer.valueBoolean)
      : (answer.valueString ??
        answer.valueCodes?.join(',') ??
        answer.valueDate ??
        (answer.valueNumber !== undefined ? String(answer.valueNumber) : undefined));

/**
 * Validates answers against the exact questionnaire version: unknown or duplicate questions,
 * wrong types, invalid options and missing required (enabled) answers are rejected. Returns the
 * red flags raised.
 */
export function evaluateAnswers(questionnaire: QuestionnaireRow, answers: Answer[]) {
  const items = questionnaire.toObject().items;
  const byId = new Map(answers.map((answer) => [answer.linkId, answer]));
  if (byId.size !== answers.length) throw ApiError.badRequest('Answer each question once');
  const known = new Set(items.map((item) => item.linkId));
  const unknown = answers.find((answer) => !known.has(answer.linkId));
  if (unknown) throw ApiError.badRequest(`Unknown question ${unknown.linkId}`);
  const redFlags: string[] = [];
  for (const item of items) {
    const enabled =
      !item.enableWhen || answerText(byId.get(item.enableWhen.linkId)) === item.enableWhen.equals;
    const answer = byId.get(item.linkId);
    if (!enabled) {
      if (answer) throw ApiError.badRequest(`Question ${item.linkId} does not apply`);
      continue;
    }
    if (!answer) {
      if (item.required) throw ApiError.badRequest(`Answer the required question ${item.linkId}`);
      continue;
    }
    const fail = () => ApiError.badRequest(`Invalid answer for ${item.linkId}`);
    const codes = new Set(item.options.map((option) => option.code));
    switch (item.type) {
      case 'BOOLEAN':
        if (answer.valueBoolean === undefined) throw fail();
        if (item.redFlagIfTrue && answer.valueBoolean) redFlags.push(item.linkId);
        break;
      case 'CHOICE':
      case 'MULTI_CHOICE': {
        const chosen = answer.valueCodes ?? [];
        if (!chosen.length || (item.type === 'CHOICE' && chosen.length !== 1)) throw fail();
        if (chosen.some((code) => !codes.has(code)) || new Set(chosen).size !== chosen.length)
          throw fail();
        for (const option of item.options)
          if (option.redFlag && chosen.includes(option.code))
            redFlags.push(`${item.linkId}:${option.code}`);
        break;
      }
      case 'TEXT':
        if (!answer.valueString) throw fail();
        break;
      case 'NUMBER':
        if (
          answer.valueNumber === undefined ||
          (item.min != null && answer.valueNumber < item.min) ||
          (item.max != null && answer.valueNumber > item.max)
        )
          throw fail();
        break;
      case 'DATE':
        if (!answer.valueDate) throw fail();
        break;
    }
  }
  return redFlags;
}

const URGENT_ADVICE =
  'Some answers suggest you may need urgent care. If you have severe symptoms, call 112 or go to the nearest emergency department now instead of waiting for this appointment.';

/** The patient (or a representative with medical authority) answers before the visit. */
export async function submitIntake(
  actor: CommandActor,
  appointmentId: string,
  input: z.infer<typeof intakeSubmission>,
  key: string,
) {
  const preview = await Appointment.findById(appointmentId);
  if (!preview) throw ApiError.notFound();
  await authorizePatient(actor, String(preview.patientId), 'medical.upload');
  return command(actor, 'self', `intake.submit:${appointmentId}`, key, input, async (session) => {
    const appointment = await Appointment.findById(appointmentId).session(session);
    if (!appointment) throw ApiError.notFound();
    await authorizePatient(actor, String(appointment.patientId), 'medical.upload', session, true);
    if (!['HELD', 'CONFIRMED', 'CHECKED_IN'].includes(appointment.status))
      conflict('Intake is closed for this appointment');
    const assignment = await QuestionnaireAssignment.findOne({
      offeringId: appointment.offeringId,
      status: 'ACTIVE',
    }).session(session);
    if (!assignment) throw ApiError.notFound('This service has no intake questionnaire');
    const questionnaire = await Questionnaire.findOne({
      _id: assignment.questionnaireId,
      status: 'PUBLISHED',
    }).session(session);
    if (!questionnaire) throw ApiError.notFound('The questionnaire was retired');
    const redFlags = evaluateAnswers(questionnaire, input.answers);
    const previous = await IntakeResponse.findOne({
      appointmentId,
      questionnaireId: questionnaire._id,
      status: { $in: ['SUBMITTED', 'REVIEWED'] },
    }).session(session);
    if (previous) {
      previous.status = 'SUPERSEDED';
      previous.updatedBy = who(actor);
      await previous.save({ session });
    }
    const [row] = await IntakeResponse.create(
      [
        {
          ...stamp(actor.userId),
          organizationId: appointment.organizationId,
          facilityId: appointment.facilityId,
          patientId: appointment.patientId,
          appointmentId: appointment._id,
          questionnaireId: questionnaire._id,
          questionnaireSnapshot: {
            code: questionnaire.code,
            questionnaireVersion: questionnaire.questionnaireVersion,
            contentHash: questionnaire.contentHash!,
            title: questionnaire.title,
          },
          answers: input.answers,
          redFlags,
          submittedBy: who(actor),
          supersedesId: previous?._id,
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId: String(appointment.organizationId),
        patientId: String(appointment.patientId),
        action: redFlags.length ? 'IntakeSubmittedWithRedFlags' : 'IntakeSubmitted',
        resourceType: 'intakeResponse',
        resourceId: String(row!._id),
        version: 0,
      },
      session,
    );
    return { id: String(row!._id), version: 0 };
  }).then(async (result) => {
    const row = await IntakeResponse.findById(result.id).select({ redFlags: 1 }).lean();
    return {
      ...result,
      redFlags: row?.redFlags ?? [],
      advice: row?.redFlags.length ? URGENT_ADVICE : undefined,
    };
  });
}

const presentResponse = (row: ReturnType<typeof IntakeResponse.hydrate>) => ({
  id: String(row._id),
  appointmentId: String(row.appointmentId),
  questionnaire: row.questionnaireSnapshot,
  answers: row.toObject().answers,
  redFlags: row.redFlags,
  status: row.status,
  submittedAt: row.get('createdAt') as Date,
  reviewedAt: row.reviewedAt,
  version: row.version,
});

/** Patient view of their own submitted intake. */
export async function myIntake(actor: CommandActor, appointmentId: string) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw ApiError.notFound();
  await authorizePatient(actor, String(appointment.patientId), 'medical.read');
  const rows = await IntakeResponse.find({
    appointmentId,
    status: { $in: ['SUBMITTED', 'REVIEWED'] },
  });
  return { items: rows.map(presentResponse) };
}

/**
 * Provider view: the appointment's own clinician (before any encounter exists) or the patient's
 * care team. Administration alone never sees patient-reported health information.
 */
async function authorizeIntakeReader(
  actor: CommandActor,
  organizationId: string,
  appointmentId: string,
  permission: 'clinical.read' | 'clinical.write',
  session?: ClientSession,
) {
  const appointment = await Appointment.findOne({ _id: appointmentId, organizationId }).session(
    session ?? null,
  );
  if (!appointment) throw ApiError.notFound();
  const facilityId = String(appointment.facilityId);
  await authorizeOrganization(actor, organizationId, permission, {
    facilityId,
    session,
    activeProvider: true,
  });
  const practitioner = await Practitioner.findOne({ userId: actor.userId, status: 'ACTIVE' })
    .session(session ?? null)
    .lean();
  if (practitioner && String(practitioner._id) === String(appointment.practitionerId))
    return { appointment, practitioner };
  const access = await authorizeClinical(
    actor,
    organizationId,
    String(appointment.patientId),
    permission,
    { session, facilityId },
  );
  return { appointment, practitioner: access.practitioner };
}

export async function appointmentIntake(
  actor: CommandActor,
  organizationId: string,
  appointmentId: string,
) {
  const { appointment } = await authorizeIntakeReader(
    actor,
    organizationId,
    appointmentId,
    'clinical.read',
  );
  const rows = await IntakeResponse.find({
    appointmentId,
    status: { $in: ['SUBMITTED', 'REVIEWED'] },
  });
  await recordRead(
    actor,
    'intakeResponse',
    appointmentId,
    organizationId,
    String(appointment.patientId),
  );
  return { items: rows.map(presentResponse) };
}

export async function reviewIntake(
  actor: CommandActor,
  organizationId: string,
  responseId: string,
  expectedVersion: number,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `intake.review:${responseId}`,
    key,
    { expectedVersion },
    async (session) => {
      const row = await IntakeResponse.findOne({
        _id: responseId,
        organizationId,
        version: expectedVersion,
        status: 'SUBMITTED',
      }).session(session);
      if (!row) conflict();
      const { practitioner } = await authorizeIntakeReader(
        actor,
        organizationId,
        String(row.appointmentId),
        'clinical.write',
        session,
      );
      row.status = 'REVIEWED';
      row.reviewedBy = practitioner._id as Types.ObjectId;
      row.reviewedAt = new Date();
      row.updatedBy = who(actor);
      await row.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(row.patientId),
          action: 'IntakeReviewed',
          resourceType: 'intakeResponse',
          resourceId: responseId,
          version: row.version,
        },
        session,
      );
      return { id: responseId, version: row.version };
    },
  );
}

// ── Concern-to-specialty routing ─────────────────────────────────────────────

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export async function proposeConcern(
  actor: CommandActor,
  input: z.infer<typeof concernInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.CATALOG_MANAGE);
  return command(actor, 'platform', 'concern.propose', key, input, async (session) => {
    const specialties = await Specialty.countDocuments({
      _id: { $in: input.specialtyIds },
      status: 'ACTIVE',
    }).session(session);
    if (specialties !== new Set(input.specialtyIds).size)
      throw ApiError.badRequest('Choose active specialties');
    const [row] = await ConcernMapping.create(
      [
        {
          ...stamp(actor.userId),
          ...input,
          proposedBy: actor.userId,
          searchText: normalizeText([input.display, ...input.synonyms].join(' ')),
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        action: 'ConcernMappingProposed',
        resourceType: 'concernMapping',
        resourceId: String(row!._id),
        version: 0,
      },
      session,
    );
    return { id: String(row!._id), version: 0 };
  });
}

/** Second-person approval activates the mapping and retires the previous active version. */
export async function decideConcern(
  actor: CommandActor,
  id: string,
  expectedVersion: number,
  decision: 'ACTIVE' | 'RETIRED',
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.CATALOG_MANAGE);
  return command(
    actor,
    'platform',
    `concern.${decision.toLowerCase()}:${id}`,
    key,
    { expectedVersion },
    async (session) => {
      const row = await ConcernMapping.findOne({ _id: id, version: expectedVersion }).session(
        session,
      );
      if (!row) conflict();
      if (decision === 'ACTIVE') {
        if (row.status !== 'DRAFT') conflict('Only drafts are approved');
        if (String(row.proposedBy) === actor.userId)
          throw ApiError.forbidden('A second reviewer must approve routing rules');
        await ConcernMapping.updateMany(
          { code: row.code, status: 'ACTIVE' },
          { $set: { status: 'RETIRED', updatedBy: who(actor) }, $inc: { version: 1 } },
          { session },
        );
        row.approvedBy = new Types.ObjectId(actor.userId);
        row.approvedAt = new Date();
      } else if (row.status === 'RETIRED') conflict();
      row.status = decision;
      row.updatedBy = who(actor);
      await row.save({ session });
      await recordChange(
        actor,
        {
          action: decision === 'ACTIVE' ? 'ConcernMappingActivated' : 'ConcernMappingRetired',
          resourceType: 'concernMapping',
          resourceId: id,
          version: row.version,
        },
        session,
      );
      return { id, version: row.version };
    },
  );
}

const DISCLAIMER =
  'This suggests which kind of doctor to consult. It is not a diagnosis or medical advice.';

/** Public type-ahead over active concerns (display text and synonyms). */
export async function searchConcerns(query: z.infer<typeof concernSearch>) {
  const terms = normalizeText(query.q).split(' ').filter(Boolean).slice(0, 5);
  const rows = await ConcernMapping.find({
    status: 'ACTIVE',
    $and: terms.map((term) => ({ searchText: { $regex: escapeRegex(term) } })),
  })
    .limit(query.limit)
    .lean();
  return {
    items: rows.map((row) => ({
      code: row.code,
      display: row.display,
      urgency: row.urgency,
    })),
  };
}

const URGENCY_ORDER = { ROUTINE: 0, URGENT: 1, EMERGENCY: 2 } as const;

/**
 * Routes selected concerns to specialties. Emergencies return emergency advice and are marked
 * not bookable: the patient is told to seek emergency care instead of a routine appointment.
 */
export async function routeConcerns(input: z.infer<typeof routeInput>) {
  const concerns = await ConcernMapping.find({
    code: { $in: input.concernCodes },
    status: 'ACTIVE',
  }).lean();
  const applicable = concerns.filter(
    (row) =>
      input.ageYears === undefined ||
      ((row.minAgeYears == null || input.ageYears >= row.minAgeYears) &&
        (row.maxAgeYears == null || input.ageYears <= row.maxAgeYears)),
  );
  if (!applicable.length) throw ApiError.notFound('No routing guidance matches these concerns');
  const urgency = applicable.reduce<'ROUTINE' | 'URGENT' | 'EMERGENCY'>(
    (current, row) => (URGENCY_ORDER[row.urgency] > URGENCY_ORDER[current] ? row.urgency : current),
    'ROUTINE',
  );
  const counts = new Map<string, string[]>();
  for (const row of applicable)
    for (const id of row.specialtyIds)
      counts.set(String(id), [...(counts.get(String(id)) ?? []), row.code]);
  const specialties = await Specialty.find({
    _id: { $in: [...counts.keys()] },
    status: 'ACTIVE',
  }).lean();
  return {
    urgency,
    bookable: urgency !== 'EMERGENCY',
    advice: applicable
      .filter((row) => row.urgency === urgency)
      .map((row) => row.advice)
      .join(' '),
    specialties: specialties
      .map((row) => ({
        id: String(row._id),
        code: row.code,
        name: row.name,
        matchedConcerns: counts.get(String(row._id)) ?? [],
      }))
      .sort((a, b) => b.matchedConcerns.length - a.matchedConcerns.length),
    disclaimer: DISCLAIMER,
  };
}

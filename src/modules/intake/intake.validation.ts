import { z } from 'zod';
import { objectId } from '../../shared/domain/healthcare.js';

const version = z.number().int().min(0);
const linkId = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,59}$/u, 'Use lowercase letters, digits, - or _');

export const questionnaireItemInput = z
  .strictObject({
    linkId,
    text: z.string().trim().min(1).max(500),
    type: z.enum(['BOOLEAN', 'CHOICE', 'MULTI_CHOICE', 'TEXT', 'NUMBER', 'DATE']),
    required: z.boolean().default(false),
    options: z
      .array(
        z.strictObject({
          code: z.string().trim().min(1).max(60),
          display: z.string().trim().min(1).max(200),
          redFlag: z.boolean().default(false),
        }),
      )
      .max(30)
      .default([]),
    redFlagIfTrue: z.boolean().default(false),
    min: z.number().optional(),
    max: z.number().optional(),
    enableWhen: z.strictObject({ linkId, equals: z.string().trim().min(1).max(60) }).optional(),
  })
  .superRefine((item, ctx) => {
    const choice = item.type === 'CHOICE' || item.type === 'MULTI_CHOICE';
    if (choice && item.options.length < 2)
      ctx.addIssue({ code: 'custom', message: 'Choice questions need at least two options' });
    if (!choice && item.options.length)
      ctx.addIssue({ code: 'custom', message: 'Only choice questions have options' });
    if (new Set(item.options.map((option) => option.code)).size !== item.options.length)
      ctx.addIssue({ code: 'custom', message: 'Option codes must be unique' });
    if (item.redFlagIfTrue && item.type !== 'BOOLEAN')
      ctx.addIssue({ code: 'custom', message: 'Only yes/no questions use redFlagIfTrue' });
  });

export const questionnaireInput = z
  .strictObject({
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9][A-Z0-9_-]{1,79}$/u),
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(2000).optional(),
    language: z.string().trim().min(2).max(10).default('en'),
    items: z.array(questionnaireItemInput).min(1).max(60),
  })
  .superRefine((value, ctx) => {
    const ids = value.items.map((item) => item.linkId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Question identifiers must be unique' });
    value.items.forEach((item, index) => {
      if (item.enableWhen && !ids.slice(0, index).includes(item.enableWhen.linkId))
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'enableWhen'],
          message: 'A condition must refer to an earlier question',
        });
    });
  });
export const questionnaireDraftUpdate = z.strictObject({
  expectedVersion: version,
  questionnaire: questionnaireInput,
});
export const expectedVersionInput = z.strictObject({ expectedVersion: version });
export const assignmentInput = z.strictObject({
  questionnaireId: objectId,
  required: z.boolean().default(true),
});

export const answerInput = z.strictObject({
  linkId,
  valueBoolean: z.boolean().optional(),
  valueString: z.string().trim().max(4000).optional(),
  valueCodes: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  valueNumber: z.number().finite().optional(),
  valueDate: z.iso.date().optional(),
});
export const intakeSubmission = z.strictObject({
  answers: z.array(answerInput).max(60),
});

export const concernInput = z
  .strictObject({
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9][A-Z0-9_-]{1,79}$/u),
    display: z.string().trim().min(2).max(200),
    synonyms: z.array(z.string().trim().min(2).max(100)).max(30).default([]),
    specialtyIds: z.array(objectId).min(1).max(10),
    urgency: z.enum(['ROUTINE', 'URGENT', 'EMERGENCY']),
    advice: z.string().trim().min(10).max(1000),
    minAgeYears: z.number().int().min(0).max(120).optional(),
    maxAgeYears: z.number().int().min(0).max(120).optional(),
  })
  .refine(
    (v) =>
      v.minAgeYears === undefined || v.maxAgeYears === undefined || v.minAgeYears <= v.maxAgeYears,
    {
      message: 'Minimum age must not exceed maximum age',
    },
  );
export const concernSearch = z.strictObject({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export const routeInput = z.strictObject({
  concernCodes: z.array(z.string().trim().min(2).max(80)).min(1).max(10),
  ageYears: z.number().int().min(0).max(120).optional(),
});
export const questionnaireQuery = z.strictObject({
  status: z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: objectId.optional(),
});

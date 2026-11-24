import { randomBytes } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import {
  before,
  formatNumber,
  nextNumber,
  pageOf,
  scoped,
} from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';
import { authorizeOrganization } from '../access/access.service.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { Facility } from '../organizations/organization.model.js';
import { PatientRegistration } from '../patients/patient.model.js';
import { recordChange, recordRead } from '../operations/operation.service.js';
import { ownPractitioner } from '../clinical/clinical.policy.js';
import { encounterForWrite } from '../clinical/encounter.service.js';
import { Observation } from '../clinical/clinical.model.js';
import { observationValueFields } from '../clinical/record.service.js';
import { normalize, writeRevision } from '../clinical/revision.service.js';
import { createTaskInternal } from '../clinical/task.service.js';
import {
  DiagnosticReport,
  DiagnosticTest,
  ImagingStudy,
  ServiceOrder,
  Specimen,
} from './diagnostic.model.js';
import type {
  amendReportInput,
  catalogQuery,
  imagingStudyInput,
  orderInput,
  orderTransitionInput,
  reportInput,
  specimenInput,
  specimenTransitionInput,
  testCatalogInput,
  verifyReportInput,
  worklistQuery,
} from './diagnostic.validation.js';

const who = (actor: CommandActor) => ({ kind: 'USER' as const, id: actor.userId });
const dec = (value?: string) =>
  value === undefined ? undefined : Types.Decimal128.fromString(value);
const CRITICAL = new Set(['CRITICAL_LOW', 'CRITICAL_HIGH']);

/** Laboratory staff act on accepted work; they receive order context, not the full chart. */
async function authorizeLab(
  actor: CommandActor,
  organizationId: string,
  permission: 'diagnostics.manage' | 'diagnostics.verify',
  facilityId: string,
  session?: ClientSession,
) {
  const scope = session
    ? await scoped(actor, organizationId, permission, session, { facilityId, activeProvider: true })
    : await authorizeOrganization(actor, organizationId, permission, {
        facilityId,
        activeProvider: true,
      });
  const practitioner = await ownPractitioner(actor, session, [
    'LAB_PROFESSIONAL',
    'DOCTOR',
    'NURSE',
  ]);
  return { scope, practitioner };
}

// ── Catalog ──────────────────────────────────────────────────────────────────

export async function addCatalogTest(
  actor: CommandActor,
  input: z.infer<typeof testCatalogInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.CATALOG_MANAGE);
  try {
    return await command(
      actor,
      'platform',
      'diagnostic-test.create',
      key,
      input,
      async (session) => {
        const [row] = await DiagnosticTest.create([{ ...stamp(actor.userId), ...input }], {
          session,
        });
        await recordChange(
          actor,
          {
            action: 'DiagnosticTestCataloged',
            resourceType: 'diagnosticTest',
            resourceId: String(row!._id),
            version: 0,
          },
          session,
        );
        return { id: String(row!._id), version: 0 };
      },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) conflict('This test code and release already exist');
    throw error;
  }
}

export async function listCatalogTests(query: z.infer<typeof catalogQuery>) {
  const rows = await DiagnosticTest.find({
    status: 'ACTIVE',
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.q
      ? { name: { $regex: query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
      : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, (row) => ({
    id: String(row._id),
    system: row.system,
    code: row.code,
    release: row.release,
    name: row.name,
    kind: row.kind,
    analytes: row.analytes,
    specimenRequirements: row.specimenRequirements,
    preparationInstructions: row.preparationInstructions,
  }));
}

// ── Orders ───────────────────────────────────────────────────────────────────

/** Placing an order seals it as a signed revision; an order is not proof the test happened. */
export async function placeOrder(
  actor: CommandActor,
  organizationId: string,
  encounterId: string,
  input: z.infer<typeof orderInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `service-order.place:${encounterId}`,
    key,
    input,
    async (session) => {
      const { encounter, practitioner } = await encounterForWrite(
        actor,
        organizationId,
        encounterId,
        session,
        'diagnostics.order',
      );
      const facility = await Facility.findOne({
        _id: input.performingFacilityId,
        organizationId,
        status: 'ACTIVE',
      }).session(session);
      if (!facility) throw ApiError.notFound('Performing facility is unavailable');
      if (
        input.testCatalogId &&
        !(await DiagnosticTest.exists({ _id: input.testCatalogId, status: 'ACTIVE' }).session(
          session,
        ))
      )
        throw ApiError.notFound('Catalog test is unavailable');
      const order = new ServiceOrder({
        ...stamp(actor.userId),
        organizationId,
        patientId: encounter.patientId,
        patientRegistrationId: encounter.patientRegistrationId,
        encounterId,
        provenance: { source: 'CLINICIAN', recordedAt: new Date(), recordedBy: who(actor) },
        orderNumber: formatNumber(
          'ORD',
          await nextNumber(organizationId, 'SERVICE_ORDER', session),
        ),
        ...input,
        requestedBy: practitioner._id,
        requestedAt: new Date(),
      });
      await writeRevision(actor, 'serviceOrder', order, 'SIGNED', 'Order placed', session, {
        authorId: practitioner._id,
        signer: { practitionerId: String(practitioner._id), userId: actor.userId },
      });
      await order.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(encounter.patientId),
          action: 'ServiceOrderPlaced',
          resourceType: 'serviceOrder',
          resourceId: String(order._id),
          version: order.version,
        },
        session,
      );
      return { id: String(order._id), version: order.version };
    },
  );
}

export async function transitionOrder(
  actor: CommandActor,
  organizationId: string,
  orderId: string,
  input: z.infer<typeof orderTransitionInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `service-order.${input.action}:${orderId}`,
    key,
    input,
    async (session) => {
      const order = await ServiceOrder.findOne({
        _id: orderId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!order) conflict();
      if (input.action === 'accept') {
        await authorizeLab(
          actor,
          organizationId,
          'diagnostics.manage',
          String(order.performingFacilityId),
          session,
        );
        if (order.status !== 'PLACED') conflict('Only placed orders can be accepted');
        order.status = 'ACCEPTED';
      } else {
        if (!input.reason) throw ApiError.badRequest('A cancellation reason is required');
        const practitioner = await ownPractitioner(actor, session);
        const isRequester = String(order.requestedBy) === String(practitioner._id);
        await scoped(
          actor,
          organizationId,
          isRequester ? 'diagnostics.order' : 'diagnostics.manage',
          session,
        );
        if (!['PLACED', 'ACCEPTED'].includes(order.status))
          conflict('Orders with results cannot be cancelled');
        order.status = 'CANCELLED';
        order.cancelReason = input.reason;
      }
      order.updatedBy = who(actor);
      await order.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(order.patientId),
          action: `ServiceOrder.${input.action}`,
          resourceType: 'serviceOrder',
          resourceId: orderId,
          version: order.version,
          reason: input.reason,
        },
        session,
      );
      return { id: orderId, version: order.version };
    },
  );
}

/** Facility worklist with the minimum patient context needed to collect and identify samples. */
export async function worklist(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof worklistQuery>,
) {
  await authorizeLab(actor, organizationId, 'diagnostics.manage', query.facilityId);
  const rows = await ServiceOrder.find({
    organizationId,
    performingFacilityId: query.facilityId,
    status: query.status ?? { $in: ['PLACED', 'ACCEPTED', 'IN_PROGRESS'] },
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  const registrations = await PatientRegistration.find({
    _id: { $in: rows.map((row) => row.patientRegistrationId) },
  })
    .select({ mrn: 1, 'demographicSnapshot.name.display': 1, 'demographicSnapshot.birthDate': 1 })
    .lean();
  const byId = new Map(registrations.map((row) => [String(row._id), row]));
  return pageOf(rows, query.limit, (row) => {
    const registration = byId.get(String(row.patientRegistrationId));
    return {
      id: String(row._id),
      orderNumber: row.orderNumber,
      kind: row.kind,
      code: row.code,
      priority: row.priority,
      status: row.status,
      instructions: row.instructions,
      requestedAt: row.requestedAt,
      patient: {
        registrationId: String(row.patientRegistrationId),
        mrn: registration?.mrn,
        name: registration?.demographicSnapshot.name.display,
        birthDate: registration?.demographicSnapshot.birthDate,
      },
      version: row.version,
    };
  });
}

// ── Specimens ────────────────────────────────────────────────────────────────

async function acceptedOrders(organizationId: string, orderIds: string[], session: ClientSession) {
  const orders = await ServiceOrder.find({
    _id: { $in: orderIds },
    organizationId,
    status: { $in: ['ACCEPTED', 'IN_PROGRESS'] },
  }).session(session);
  if (orders.length !== new Set(orderIds).size)
    throw ApiError.notFound('Every order must be accepted by the laboratory');
  if (new Set(orders.map((order) => String(order.patientId))).size !== 1)
    throw ApiError.badRequest('A specimen belongs to exactly one patient');
  if (new Set(orders.map((order) => String(order.performingFacilityId))).size !== 1)
    throw ApiError.badRequest('Orders must share a performing facility');
  return orders;
}

export async function collectSpecimen(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof specimenInput>,
  key: string,
) {
  return command(actor, organizationId, 'specimen.collect', key, input, async (session) => {
    const orders = await acceptedOrders(organizationId, input.serviceOrderIds, session);
    const first = orders[0]!;
    const { practitioner } = await authorizeLab(
      actor,
      organizationId,
      'diagnostics.manage',
      String(first.performingFacilityId),
      session,
    );
    if (
      input.parentSpecimenId &&
      !(await Specimen.exists({
        _id: input.parentSpecimenId,
        organizationId,
        patientId: first.patientId,
      }).session(session))
    )
      throw ApiError.notFound('Parent specimen is unavailable');
    const [specimen] = await Specimen.create(
      [
        {
          ...stamp(actor.userId),
          organizationId,
          patientId: first.patientId,
          patientRegistrationId: first.patientRegistrationId,
          encounterId: first.encounterId,
          serviceOrderIds: orders.map((order) => order._id),
          accessionNumber: formatNumber(
            'ACC',
            await nextNumber(organizationId, 'ACCESSION', session),
            10,
          ),
          barcode: randomBytes(9).toString('base64url').toUpperCase(),
          type: input.type,
          container: input.container,
          parentSpecimenId: input.parentSpecimenId,
          collectedAt: new Date(),
          collectedBy: practitioner._id,
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId,
        patientId: String(first.patientId),
        action: 'SpecimenCollected',
        resourceType: 'specimen',
        resourceId: String(specimen!._id),
        version: 0,
      },
      session,
    );
    return { id: String(specimen!._id), version: 0 };
  });
}

export async function transitionSpecimen(
  actor: CommandActor,
  organizationId: string,
  specimenId: string,
  input: z.infer<typeof specimenTransitionInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `specimen.${input.action}:${specimenId}`,
    key,
    input,
    async (session) => {
      const specimen = await Specimen.findOne({
        _id: specimenId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!specimen) conflict();
      const order = await ServiceOrder.findById(specimen.serviceOrderIds[0]).session(session);
      const { practitioner } = await authorizeLab(
        actor,
        organizationId,
        'diagnostics.manage',
        String(order!.performingFacilityId),
        session,
      );
      if (input.action === 'receive') {
        if (specimen.status !== 'COLLECTED') conflict('Only collected specimens can be received');
        specimen.set({ status: 'RECEIVED', receivedAt: new Date(), receivedBy: practitioner._id });
      } else {
        if (!input.reason) throw ApiError.badRequest('A rejection reason is required');
        if (!['COLLECTED', 'RECEIVED'].includes(specimen.status))
          conflict('This specimen cannot be rejected');
        // A rejected specimen requires recollection; the orders stay open.
        specimen.set({ status: 'REJECTED', rejectionReason: input.reason });
      }
      specimen.updatedBy = who(actor);
      await specimen.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(specimen.patientId),
          action: `Specimen.${input.action}`,
          resourceType: 'specimen',
          resourceId: specimenId,
          version: specimen.version,
          reason: input.reason,
        },
        session,
      );
      return { id: specimenId, version: specimen.version };
    },
  );
}

// ── Results and reports ──────────────────────────────────────────────────────

/** Records preliminary results. Every result is validated against its order, specimen and patient. */
export async function createReport(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof reportInput>,
  key: string,
) {
  return command(actor, organizationId, 'diagnostic-report.create', key, input, async (session) => {
    const orders = await acceptedOrders(organizationId, input.serviceOrderIds, session);
    const first = orders[0]!;
    const { practitioner } = await authorizeLab(
      actor,
      organizationId,
      'diagnostics.manage',
      String(first.performingFacilityId),
      session,
    );
    const orderIds = new Set(orders.map((order) => String(order._id)));
    const specimenIds = new Set<string>();
    const resultIds: Types.ObjectId[] = [];
    for (const result of input.results) {
      if (!orderIds.has(result.serviceOrderId))
        throw ApiError.badRequest('A result references an order outside this report');
      if (result.specimenId) {
        const specimen = await Specimen.findOne({
          _id: result.specimenId,
          organizationId,
          patientId: first.patientId,
          serviceOrderIds: result.serviceOrderId,
          status: 'RECEIVED',
        }).session(session);
        if (!specimen)
          throw ApiError.badRequest(
            'Results need a received specimen for the same patient and order',
          );
        specimenIds.add(result.specimenId);
      }
      const observation = new Observation({
        ...stamp(actor.userId),
        organizationId,
        patientId: first.patientId,
        patientRegistrationId: first.patientRegistrationId,
        encounterId: first.encounterId,
        provenance: {
          source: 'CLINICIAN',
          recordedAt: new Date(),
          recordedBy: who(actor),
          effectiveAt: new Date(result.effectiveAt),
        },
        category: 'LABORATORY',
        code: result.code,
        ...observationValueFields(result.value),
        status: 'PRELIMINARY',
        effectiveAt: new Date(result.effectiveAt),
        referenceRange: result.referenceRange
          ? {
              ...result.referenceRange,
              low: dec(result.referenceRange.low),
              high: dec(result.referenceRange.high),
            }
          : undefined,
        interpretation: result.interpretation,
        serviceOrderId: result.serviceOrderId,
        specimenId: result.specimenId,
        performerId: practitioner._id,
      });
      await writeRevision(
        actor,
        'observation',
        observation,
        'RECORDED',
        'Result entered',
        session,
        { authorId: practitioner._id },
      );
      await observation.save({ session });
      resultIds.push(observation._id);
    }
    const [report] = await DiagnosticReport.create(
      [
        {
          ...stamp(actor.userId),
          organizationId,
          patientId: first.patientId,
          patientRegistrationId: first.patientRegistrationId,
          encounterId: first.encounterId,
          reportNumber: formatNumber(
            'RPT',
            await nextNumber(organizationId, 'DIAGNOSTIC_REPORT', session),
          ),
          serviceOrderIds: orders.map((order) => order._id),
          specimenIds: [...specimenIds],
          code: input.code,
          resultIds,
          conclusion: input.conclusion,
          performerOrganizationId: organizationId,
          enteredBy: practitioner._id,
          critical: input.results.some(
            (result) => result.interpretation && CRITICAL.has(result.interpretation),
          ),
        },
      ],
      { session },
    );
    await ServiceOrder.updateMany(
      { _id: { $in: [...orderIds] }, status: 'ACCEPTED' },
      { $set: { status: 'IN_PROGRESS' }, $inc: { version: 1 } },
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId,
        patientId: String(first.patientId),
        action: 'DiagnosticReportDrafted',
        resourceType: 'diagnosticReport',
        resourceId: String(report!._id),
        version: 0,
      },
      session,
    );
    return { id: String(report!._id), version: 0 };
  });
}

async function notifyOrderer(
  actor: CommandActor,
  report: ReturnType<typeof DiagnosticReport.hydrate>,
  title: string,
  critical: boolean,
  session: ClientSession,
) {
  const orders = await ServiceOrder.find({ _id: { $in: report.serviceOrderIds } }).session(session);
  for (const requester of new Set(orders.map((order) => String(order.requestedBy))))
    await createTaskInternal(
      actor,
      {
        organizationId: String(report.organizationId),
        patientId: String(report.patientId),
        patientRegistrationId: String(report.patientRegistrationId),
        kind: critical ? 'CRITICAL_RESULT' : 'RESULT_REVIEW',
        title,
        sourceRef: { type: 'diagnosticReport', id: String(report._id) },
        assigneeId: requester,
        dueAt: new Date(Date.now() + (critical ? 30 * 60_000 : 48 * 3600_000)),
        priority: critical ? 'CRITICAL' : 'ROUTINE',
      },
      session,
    );
}

/** Verification finalizes results and creates result-review (or critical-result) work for the orderer. */
export async function verifyReport(
  actor: CommandActor,
  organizationId: string,
  reportId: string,
  input: z.infer<typeof verifyReportInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `diagnostic-report.verify:${reportId}`,
    key,
    input,
    async (session) => {
      const report = await DiagnosticReport.findOne({
        _id: reportId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!report) conflict();
      const order = await ServiceOrder.findById(report.serviceOrderIds[0]).session(session);
      const { practitioner } = await authorizeLab(
        actor,
        organizationId,
        'diagnostics.verify',
        String(order!.performingFacilityId),
        session,
      );
      if (report.status !== 'PRELIMINARY') conflict('Only preliminary reports can be verified');
      if (!report.resultIds.length && !report.conclusion)
        throw new ApiError(
          422,
          'A report needs results or a conclusion',
          undefined,
          'INCOMPLETE_RECORD',
        );
      const observations = await Observation.find({ _id: { $in: report.resultIds } }).session(
        session,
      );
      for (const observation of observations) {
        observation.status = 'FINAL';
        observation.updatedBy = who(actor);
        await writeRevision(
          actor,
          'observation',
          observation,
          'SIGNED',
          'Result verified',
          session,
          {
            authorId: practitioner._id,
            signer: { practitionerId: String(practitioner._id), userId: actor.userId },
          },
        );
        await observation.save({ session });
      }
      report.set({
        status: 'FINAL',
        issuedAt: new Date(),
        resultsInterpreterId: practitioner._id,
        updatedBy: who(actor),
      });
      await writeRevision(actor, 'diagnosticReport', report, 'SIGNED', 'Report verified', session, {
        authorId: practitioner._id,
        signer: { practitionerId: String(practitioner._id), userId: actor.userId },
        extra: { results: observations.map((row) => row.toObject({ depopulate: true })) },
      });
      await report.save({ session });
      await ServiceOrder.updateMany(
        { _id: { $in: report.serviceOrderIds }, status: { $in: ['ACCEPTED', 'IN_PROGRESS'] } },
        { $set: { status: 'COMPLETED' }, $inc: { version: 1 } },
        { session },
      );
      await notifyOrderer(
        actor,
        report,
        report.critical
          ? `Critical result: ${report.code.text}`
          : `Review result: ${report.code.text}`,
        report.critical,
        session,
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(report.patientId),
          action: report.critical ? 'CriticalResultFinalized' : 'DiagnosticReportFinalized',
          resourceType: 'diagnosticReport',
          resourceId: reportId,
          version: report.version,
        },
        session,
      );
      return { id: reportId, version: report.version };
    },
  );
}

/** Corrections create new revisions; the original verified values remain in history. */
export async function amendReport(
  actor: CommandActor,
  organizationId: string,
  reportId: string,
  input: z.infer<typeof amendReportInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `diagnostic-report.amend:${reportId}`,
    key,
    input,
    async (session) => {
      const report = await DiagnosticReport.findOne({
        _id: reportId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!report) conflict();
      const order = await ServiceOrder.findById(report.serviceOrderIds[0]).session(session);
      const { practitioner } = await authorizeLab(
        actor,
        organizationId,
        'diagnostics.verify',
        String(order!.performingFacilityId),
        session,
      );
      if (!['FINAL', 'AMENDED'].includes(report.status))
        conflict('Only verified reports are amended');
      const signer = { practitionerId: String(practitioner._id), userId: actor.userId };
      let critical = report.critical;
      for (const correction of input.corrections) {
        if (!report.resultIds.some((id) => String(id) === correction.observationId))
          throw ApiError.badRequest('A correction references a result outside this report');
        const observation = await Observation.findById(correction.observationId).session(session);
        if (!observation) throw ApiError.notFound();
        observation.set({
          valueQuantity: undefined,
          valueText: undefined,
          valueCode: undefined,
          valueBoolean: undefined,
        });
        observation.set({
          ...observationValueFields(correction.value),
          interpretation: correction.interpretation,
          status: 'AMENDED',
          correctionReason: input.reason,
          updatedBy: who(actor),
        });
        await writeRevision(actor, 'observation', observation, 'AMENDED', input.reason, session, {
          authorId: practitioner._id,
          signer,
        });
        await observation.save({ session });
        if (correction.interpretation && CRITICAL.has(correction.interpretation)) critical = true;
      }
      report.set({
        status: 'AMENDED',
        conclusion: input.conclusion ?? report.conclusion,
        correctionReason: input.reason,
        critical,
        updatedBy: who(actor),
      });
      await writeRevision(actor, 'diagnosticReport', report, 'AMENDED', input.reason, session, {
        authorId: practitioner._id,
        signer,
      });
      await report.save({ session });
      // Prior recipients are alerted that the result they reviewed changed.
      await notifyOrderer(actor, report, `Amended result: ${report.code.text}`, critical, session);
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(report.patientId),
          action: 'DiagnosticReportAmended',
          resourceType: 'diagnosticReport',
          resourceId: reportId,
          version: report.version,
          reason: input.reason,
        },
        session,
      );
      return { id: reportId, version: report.version };
    },
  );
}

export async function registerImagingStudy(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof imagingStudyInput>,
  key: string,
) {
  try {
    return await command(
      actor,
      organizationId,
      'imaging-study.register',
      key,
      input,
      async (session) => {
        const order = await ServiceOrder.findOne({
          _id: input.serviceOrderId,
          organizationId,
          kind: 'IMAGING',
          status: { $in: ['ACCEPTED', 'IN_PROGRESS'] },
        }).session(session);
        if (!order) throw ApiError.notFound('An accepted imaging order is required');
        await authorizeLab(
          actor,
          organizationId,
          'diagnostics.manage',
          String(order.performingFacilityId),
          session,
        );
        const [study] = await ImagingStudy.create(
          [
            {
              ...stamp(actor.userId),
              organizationId,
              patientId: order.patientId,
              patientRegistrationId: order.patientRegistrationId,
              encounterId: order.encounterId,
              ...input,
              accessionNumber: order.orderNumber,
              startedAt: new Date(input.startedAt),
            },
          ],
          { session },
        );
        if (order.status === 'ACCEPTED') {
          order.status = 'IN_PROGRESS';
          order.updatedBy = who(actor);
          await order.save({ session });
        }
        await recordChange(
          actor,
          {
            organizationId,
            patientId: String(order.patientId),
            action: 'ImagingStudyRegistered',
            resourceType: 'imagingStudy',
            resourceId: String(study!._id),
            version: 0,
          },
          session,
        );
        return { id: String(study!._id), version: 0 };
      },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) conflict('This study is already registered');
    throw error;
  }
}

export async function getReportForLab(
  actor: CommandActor,
  organizationId: string,
  reportId: string,
  page: Pagination,
) {
  const report = await DiagnosticReport.findOne({ _id: reportId, organizationId });
  if (!report) throw ApiError.notFound();
  const order = await ServiceOrder.findById(report.serviceOrderIds[0]);
  await authorizeLab(
    actor,
    organizationId,
    'diagnostics.manage',
    String(order!.performingFacilityId),
  );
  const results = await Observation.find({ _id: { $in: report.resultIds } }).limit(page.limit);
  await recordRead(actor, 'diagnosticReport', reportId, organizationId, String(report.patientId));
  return {
    report: normalize(report.toObject()),
    results: results.map((row) => normalize(row.toObject())),
  };
}

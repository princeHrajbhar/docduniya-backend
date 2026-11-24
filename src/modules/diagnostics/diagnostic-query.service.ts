import { Types } from 'mongoose';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { ApiError } from '../../utils/api-error.js';
import { authorizePatient } from '../patients/patient.service.js';
import { recordRead } from '../operations/operation.service.js';
import { activeGrant, periodFilter } from '../privacy/grant.service.js';
import { authorizeClinical } from '../clinical/clinical.policy.js';
import { Observation } from '../clinical/clinical.model.js';
import { normalize } from '../clinical/revision.service.js';
import { DiagnosticReport, ServiceOrder } from './diagnostic.model.js';

const RELEASED = { status: { $in: ['FINAL', 'AMENDED'] } } as const;
const plain = (row: { toObject(): unknown }) => {
  const { _id, ...rest } = normalize(row.toObject()) as Record<string, unknown>;
  for (const field of ['authorizationFence', 'createdBy', 'updatedBy']) delete rest[field];
  return { id: _id, ...rest };
};

async function withResults(reports: Array<ReturnType<typeof DiagnosticReport.hydrate>>) {
  const results = await Observation.find({
    _id: { $in: reports.flatMap((report) => report.resultIds) },
  });
  const byId = new Map(results.map((row) => [String(row._id), plain(row)]));
  return reports.map((report) => ({
    ...plain(report),
    results: report.resultIds.map((id) => byId.get(String(id))).filter(Boolean),
  }));
}

/** Treating team view: orders and reports (including preliminary) within the custodian organization. */
export async function patientDiagnostics(
  actor: CommandActor,
  organizationId: string,
  patientId: string,
) {
  await authorizeClinical(actor, organizationId, patientId, 'clinical.read');
  const [orders, reports] = await Promise.all([
    ServiceOrder.find({ organizationId, patientId }).sort({ _id: -1 }).limit(100),
    DiagnosticReport.find({ organizationId, patientId }).sort({ _id: -1 }).limit(50),
  ]);
  await recordRead(actor, 'diagnostics', patientId, organizationId, patientId);
  return { orders: orders.map(plain), reports: await withResults(reports) };
}

/** Patient portal: verified reports only, across every performing provider. */
export async function patientReports(actor: CommandActor, patientId: string) {
  await authorizePatient(actor, patientId, 'profile.read');
  const reports = await DiagnosticReport.find({ patientId, ...RELEASED })
    .sort({ issuedAt: -1 })
    .limit(100);
  await recordRead(actor, 'diagnosticReport.patient', patientId, undefined, patientId);
  return withResults(reports);
}

export async function sharedDiagnosticReports(
  actor: CommandActor,
  organizationId: string,
  patientId: string,
) {
  const grant = await activeGrant(patientId, { organizationId }, 'diagnosticReports');
  if (!grant) throw ApiError.notFound('No current sharing grant covers these records');
  const reports = await DiagnosticReport.find({
    patientId,
    organizationId: { $ne: new Types.ObjectId(organizationId) },
    ...RELEASED,
    ...periodFilter(grant, 'issuedAt'),
  })
    .sort({ issuedAt: -1 })
    .limit(100);
  await recordRead(actor, 'shared.diagnosticReports', String(grant._id), organizationId, patientId);
  return {
    grantId: String(grant._id),
    expiresAt: grant.expiresAt,
    items: await withResults(reports),
  };
}

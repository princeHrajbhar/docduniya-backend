import { randomUUID } from 'node:crypto';
import type { ClientSession, Types } from 'mongoose';
import { actorRef, serviceActor, type OperationActor } from '../../shared/application/scope.js';
import { transaction } from '../../shared/application/command.js';
import { recordChange } from '../operations/operation.service.js';
import { Doctor } from '../practitioners/practitioner.model.js';
import { Appointment } from './appointment.model.js';

/**
 * Puts a practitioner's upcoming appointments on the provider's reassignment worklist (the same
 * flag doctor leave uses). Patients are not silently kept with a doctor who may not practise.
 */
export async function flagUpcomingForReassignment(
  actor: OperationActor,
  practitionerId: Types.ObjectId | string,
  session: ClientSession,
  from = new Date(),
): Promise<number> {
  const affected = await Appointment.find({
    practitionerId,
    startAt: { $gte: from },
    status: { $in: ['HELD', 'CONFIRMED'] },
    requiresReassignment: { $ne: true },
  }).session(session);
  for (const appointment of affected) {
    appointment.requiresReassignment = true;
    appointment.updatedBy = actorRef(actor);
    await appointment.save({ session });
    await recordChange(
      actor,
      {
        organizationId: String(appointment.organizationId),
        patientId: String(appointment.patientId),
        action: 'AppointmentRequiresReassignment',
        resourceType: 'appointment',
        resourceId: String(appointment._id),
        version: appointment.version,
        reason: 'Practitioner credential no longer current',
      },
      session,
    );
  }
  return affected.length;
}

/** Worker sweep: doctors whose verification lapsed get their future appointments flagged. */
export async function flagLapsedDoctorAppointments(limit = 50): Promise<number> {
  const lapsed = await Doctor.find({
    $or: [
      { verificationStatus: 'SUSPENDED' },
      { verificationStatus: 'VERIFIED', verifiedUntil: { $lte: new Date() } },
    ],
  })
    .select({ practitionerId: 1 })
    .limit(limit)
    .lean();
  let flagged = 0;
  for (const doctor of lapsed)
    flagged += await transaction((session) =>
      flagUpcomingForReassignment(
        serviceActor('credential-sweep', randomUUID()),
        doctor.practitionerId,
        session,
      ),
    );
  return flagged;
}

import { Schema, model } from 'mongoose';
import { aggregateOptions, metadataFields, ref, bounded } from '../../shared/persistence/schema.js';
import { cancellationSchema } from '../scheduling/scheduling.model.js';

const valueOptions = { _id: false, strict: 'throw', versionKey: false } as const;
export const appointmentStates = [
  'HELD',
  'CONFIRMED',
  'EXPIRED',
  'CANCELLED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'COMPLETED',
  'DISCONTINUED',
  'NO_SHOW',
] as const;

const appointmentSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    patientId: ref('Patient'),
    registrationId: ref('PatientRegistration', false),
    bookedBy: ref('User'),
    bookingNumber: { type: String, maxlength: 40 },
    source: { type: String, enum: ['MARKETPLACE', 'PROVIDER'], default: 'MARKETPLACE' },
    doctorId: ref('Doctor'),
    practitionerId: ref('Practitioner'),
    doctorAffiliationId: ref('DoctorAffiliation'),
    offeringId: ref('ServiceOffering'),
    offeringVersion: { type: Number, required: true },
    scheduleRuleId: ref('ScheduleRule'),
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    claimStartAt: { type: Date, required: true },
    claimEndAt: { type: Date, required: true },
    resourceKeys: { type: [String], required: true, validate: bounded(12) },
    holdToken: { type: String, required: true },
    holdExpiresAt: { type: Date, required: true },
    status: { type: String, enum: appointmentStates, default: 'HELD' },
    offeringSnapshot: {
      type: new Schema(
        {
          name: { type: String, required: true },
          mode: { type: String, required: true },
          durationMinutes: { type: Number, required: true },
        },
        valueOptions,
      ),
      required: true,
    },
    priceSnapshot: {
      type: new Schema(
        {
          priceId: ref('Price'),
          amountMinor: { type: Number, required: true },
          taxBasisPoints: { type: Number, default: 0 },
          taxMinor: { type: Number, required: true },
          totalMinor: { type: Number, required: true },
          currency: { type: String, enum: ['INR'], required: true },
        },
        valueOptions,
      ),
      required: true,
    },
    paymentPolicy: { type: String, enum: ['PAY_AT_PROVIDER', 'PREPAY', 'FREE'], required: true },
    cancellationPolicy: { type: cancellationSchema, required: true },
    reasonForVisit: { type: String, maxlength: 1000 },
    confirmedAt: Date,
    cancelledAt: Date,
    checkedInAt: Date,
    startedAt: Date,
    completedAt: Date,
    reason: { type: String, maxlength: 1000 },
    requiresReassignment: { type: Boolean, default: false },
    /** Set when a capture arrives for a hold that is no longer valid; operations must refund. */
    refundRequired: { type: Boolean, default: false },
  },
  aggregateOptions,
);
appointmentSchema.index({ organizationId: 1, facilityId: 1, startAt: 1 });
appointmentSchema.index({ patientId: 1, startAt: -1 });
appointmentSchema.index({ practitionerId: 1, status: 1, startAt: 1 });
appointmentSchema.index({ status: 1, holdExpiresAt: 1 });
appointmentSchema.index({ scheduleRuleId: 1, startAt: 1 });
appointmentSchema.index(
  { organizationId: 1, bookingNumber: 1 },
  { unique: true, partialFilterExpression: { bookingNumber: { $type: 'string' } } },
);
export const Appointment = model('Appointment', appointmentSchema, 'appointments');

const historySchema = new Schema(
  {
    appointmentId: ref('Appointment'),
    organizationId: ref('Organization'),
    sequence: { type: Number, required: true, min: 0 },
    actorId: { type: String, required: true },
    actorKind: { type: String, enum: ['USER', 'SERVICE'], required: true },
    action: { type: String, required: true },
    fromStatus: String,
    toStatus: { type: String, required: true },
    reason: String,
    previousStartAt: Date,
    startAt: { type: Date, required: true },
    previousEndAt: Date,
    endAt: { type: Date, required: true },
    requestId: { type: String, required: true },
    occurredAt: { type: Date, default: Date.now },
  },
  { strict: 'throw', versionKey: false, autoCreate: false, autoIndex: false },
);
historySchema.index({ organizationId: 1, appointmentId: 1, sequence: 1 }, { unique: true });
historySchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany'],
  () => {
    throw new Error('Appointment history is append-only');
  },
);
export const AppointmentHistory = model('AppointmentHistory', historySchema, 'appointmentEvents');

const queueSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    patientId: ref('Patient'),
    patientRegistrationId: ref('PatientRegistration'),
    appointmentId: ref('Appointment', false),
    localDay: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    tokenNumber: { type: Number, required: true, min: 1 },
    priority: { type: String, enum: ['ROUTINE', 'URGENT', 'EMERGENCY'], default: 'ROUTINE' },
    priorityReason: { type: String, maxlength: 1000 },
    status: {
      type: String,
      enum: ['WAITING', 'CALLED', 'IN_SERVICE', 'DONE', 'LEFT'],
      default: 'WAITING',
    },
    arrivedAt: { type: Date, required: true },
    calledAt: Date,
    servedAt: Date,
    closedAt: Date,
  },
  aggregateOptions,
);
queueSchema.index(
  { organizationId: 1, facilityId: 1, localDay: 1, tokenNumber: 1 },
  { unique: true },
);
queueSchema.index(
  { appointmentId: 1 },
  { unique: true, partialFilterExpression: { appointmentId: { $type: 'objectId' } } },
);
queueSchema.index({ organizationId: 1, facilityId: 1, localDay: 1, status: 1 });
export const QueueEntry = model('QueueEntry', queueSchema, 'queueEntries');

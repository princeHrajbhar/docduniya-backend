import { Schema, model } from 'mongoose';
import { aggregateOptions, metadataFields, ref } from '../../shared/persistence/schema.js';

/**
 * A patient waiting for an earlier slot of a service. The worker offers freed slots in arrival
 * order; an offer reserves nothing until the patient accepts, which places a normal hold.
 */
const waitlistSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    offeringId: ref('ServiceOffering'),
    patientId: ref('Patient'),
    requestedBy: ref('User'),
    earliestDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    latestDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: {
      type: String,
      enum: ['WAITING', 'OFFERED', 'BOOKED', 'EXPIRED', 'CANCELLED'],
      default: 'WAITING',
    },
    offerStartAt: Date,
    offerExpiresAt: Date,
    offerCount: { type: Number, default: 0 },
    appointmentId: ref('Appointment', false),
    closedReason: { type: String, maxlength: 200 },
  },
  aggregateOptions,
);
waitlistSchema.index(
  { patientId: 1, offeringId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['WAITING', 'OFFERED'] } } },
);
// One open offer per slot: a freed slot is never offered to two patients at once.
waitlistSchema.index(
  { offeringId: 1, offerStartAt: 1 },
  { unique: true, partialFilterExpression: { status: 'OFFERED' } },
);
waitlistSchema.index({ status: 1, offeringId: 1, _id: 1 });
waitlistSchema.index({ status: 1, offerExpiresAt: 1 });
export const WaitlistEntry = model('WaitlistEntry', waitlistSchema, 'waitlistEntries');

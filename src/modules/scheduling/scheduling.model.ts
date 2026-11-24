import { Schema, model } from 'mongoose';
import { aggregateOptions, metadataFields, bounded, ref } from '../../shared/persistence/schema.js';
const valueOptions = { _id: false, versionKey: false, strict: 'throw' } as const;
export const cancellationSchema = new Schema(
  {
    noticeHours: { type: Number, required: true, min: 0, max: 720 },
    refundBeforeBps: { type: Number, required: true, min: 0, max: 10000 },
    refundAfterBps: { type: Number, required: true, min: 0, max: 10000 },
  },
  valueOptions,
);
const resourceSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    kind: { type: String, enum: ['ROOM', 'DEVICE'], required: true },
    name: { type: String, required: true, maxlength: 200 },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    authorizationFence: { type: Number, default: 0 },
  },
  aggregateOptions,
);
resourceSchema.index({ organizationId: 1, facilityId: 1, _id: -1 });
export const FacilityResource = model('FacilityResource', resourceSchema, 'resources');
const offeringSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    doctorAffiliationId: ref('DoctorAffiliation'),
    name: { type: String, required: true, maxlength: 200 },
    mode: { type: String, enum: ['IN_PERSON', 'VIDEO', 'AUDIO'], required: true },
    durationMinutes: { type: Number, required: true, min: 5, max: 240 },
    bufferBeforeMinutes: { type: Number, required: true, min: 0, max: 120 },
    bufferAfterMinutes: { type: Number, required: true, min: 0, max: 120 },
    resourceIds: { type: [Schema.Types.ObjectId], default: [], validate: bounded(10) },
    paymentPolicy: { type: String, enum: ['PAY_AT_PROVIDER', 'PREPAY', 'FREE'], required: true },
    cancellationPolicy: { type: cancellationSchema, required: true },
    currentPriceId: ref('Price', false),
    status: { type: String, enum: ['DRAFT', 'ACTIVE', 'INACTIVE'], default: 'DRAFT' },
    authorizationFence: { type: Number, default: 0 },
  },
  aggregateOptions,
);
offeringSchema.index({ organizationId: 1, facilityId: 1, status: 1, _id: -1 });
offeringSchema.index({ doctorAffiliationId: 1, status: 1 });
export const ServiceOffering = model('ServiceOffering', offeringSchema, 'serviceOfferings');
const priceSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    offeringId: ref('ServiceOffering'),
    amountMinor: { type: Number, required: true, min: 0 },
    taxBasisPoints: { type: Number, required: true, min: 0, max: 10000 },
    taxMinor: { type: Number, required: true, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['INR'], required: true },
  },
  aggregateOptions,
);
priceSchema.index({ organizationId: 1, offeringId: 1, _id: -1 });
priceSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Published prices are immutable');
});
priceSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  function () {
    throw new Error('Published prices are immutable');
  },
);
export const Price = model('Price', priceSchema, 'prices');
const scheduleSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    offeringId: ref('ServiceOffering'),
    weekdays: { type: [{ type: Number, min: 0, max: 6 }], required: true, validate: bounded(7) },
    startMinute: { type: Number, required: true, min: 0, max: 1439 },
    endMinute: { type: Number, required: true, min: 1, max: 1440 },
    stepMinutes: { type: Number, required: true, min: 5, max: 240 },
    effectiveFrom: { type: String, required: true },
    effectiveUntil: { type: String, required: true },
    timezone: { type: String, enum: ['Asia/Kolkata'], default: 'Asia/Kolkata' },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    authorizationFence: { type: Number, default: 0 },
  },
  aggregateOptions,
);
scheduleSchema.index({ offeringId: 1, status: 1, effectiveFrom: 1, effectiveUntil: 1 });
export const ScheduleRule = model('ScheduleRule', scheduleSchema, 'scheduleRules');
const daySchema = new Schema(
  {
    resourceKey: { type: String, required: true },
    day: { type: String, required: true },
    fence: { type: Number, default: 0 },
  },
  { strict: 'throw', versionKey: false, autoCreate: false, autoIndex: false },
);
daySchema.index({ resourceKey: 1, day: 1 }, { unique: true });
export const ResourceCalendarDay = model('ResourceCalendarDay', daySchema, 'resourceCalendarDays');
const claimSchema = new Schema(
  {
    organizationId: ref('Organization', false),
    resourceKey: { type: String, required: true },
    appointmentId: ref('Appointment', false),
    blockId: ref('ScheduleException', false),
    token: { type: String, required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    expiresAt: Date,
    state: { type: String, enum: ['HELD', 'CONFIRMED', 'RELEASED'], required: true },
  },
  { timestamps: true, strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false },
);
claimSchema.index({ resourceKey: 1, state: 1, startAt: 1, endAt: 1 });
claimSchema.index({ appointmentId: 1, token: 1 });
claimSchema.index({ blockId: 1 });
export const ResourceClaim = model('ResourceClaim', claimSchema, 'resourceClaims');
const blockSchema = new Schema(
  {
    ...metadataFields,
    practitionerId: ref('Practitioner'),
    resourceKey: { type: String, required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    reason: { type: String, required: true, maxlength: 1000 },
    status: { type: String, enum: ['ACTIVE', 'CANCELLED'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
blockSchema.index({ practitionerId: 1, startAt: 1 });
export const ScheduleException = model('ScheduleException', blockSchema, 'scheduleExceptions');

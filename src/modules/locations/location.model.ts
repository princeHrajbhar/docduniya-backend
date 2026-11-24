import { Schema, model } from 'mongoose';
import { aggregateOptions, bounded, metadataFields, ref } from '../../shared/persistence/schema.js';

/**
 * Physical places inside a facility. For beds, `operationalStatus` is a projection maintained in
 * the same transaction as bed assignments, which remain the occupancy authority.
 */
const locationSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    parentId: ref('FacilityLocation', false),
    code: { type: String, required: true, maxlength: 40, match: /^[A-Z0-9][A-Z0-9-]{0,39}$/ },
    name: { type: String, required: true, maxlength: 200 },
    kind: {
      type: String,
      enum: ['BUILDING', 'FLOOR', 'WARD', 'ROOM', 'BED', 'THEATRE', 'STORE'],
      required: true,
    },
    operationalStatus: {
      type: String,
      enum: ['AVAILABLE', 'OCCUPIED', 'CLEANING', 'MAINTENANCE', 'CLOSED'],
      default: 'AVAILABLE',
    },
    capabilities: { type: [String], default: [], validate: bounded(30) },
    genderRestriction: { type: String, enum: ['FEMALE', 'MALE'] },
    isolationCapable: { type: Boolean, default: false },
    authorizationFence: { type: Number, default: 0 },
  },
  aggregateOptions,
);
locationSchema.index({ organizationId: 1, facilityId: 1, code: 1 }, { unique: true });
locationSchema.index({ organizationId: 1, facilityId: 1, kind: 1, operationalStatus: 1 });
locationSchema.index({ parentId: 1 });
export const FacilityLocation = model('FacilityLocation', locationSchema, 'facilityLocations');

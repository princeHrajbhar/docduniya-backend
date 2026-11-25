import { Schema, model } from 'mongoose';
import { aggregateOptions, metadataFields, ref } from '../../shared/persistence/schema.js';

/**
 * Independent review of a non-doctor professional's registration (nurse, pharmacist, laboratory
 * professional, therapist). Doctors keep their dedicated verification case. Approval is time
 * bounded; suspension or expiry immediately removes signing and dispensing privileges.
 */
const credentialReviewSchema = new Schema(
  {
    ...metadataFields,
    practitionerId: ref('Practitioner'),
    profession: {
      type: String,
      enum: ['NURSE', 'PHARMACIST', 'THERAPIST', 'LAB_PROFESSIONAL', 'OTHER'],
      required: true,
    },
    submittedBy: ref('User'),
    registrationSnapshot: {
      type: new Schema(
        {
          id: ref('ProfessionalRegistration'),
          version: { type: Number, required: true },
          authority: { type: String, required: true },
          jurisdiction: { type: String, required: true },
          registrationNumberNormalized: { type: String, required: true },
          issuedOn: String,
          expiresOn: String,
          evidenceReference: { type: String, required: true },
        },
        { _id: false, strict: 'throw' },
      ),
      required: true,
    },
    declaration: { type: String, required: true, maxlength: 1000 },
    status: {
      type: String,
      enum: ['SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'SUSPENDED', 'EXPIRED'],
      default: 'SUBMITTED',
    },
    reviewedBy: ref('User', false),
    reviewedAt: Date,
    reason: { type: String, maxlength: 1000 },
    checks: { type: [String], default: [] },
    validUntil: Date,
  },
  aggregateOptions,
);
credentialReviewSchema.index({ practitionerId: 1, status: 1 });
credentialReviewSchema.index(
  { practitionerId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['SUBMITTED', 'APPROVED'] } } },
);
credentialReviewSchema.index({ status: 1, validUntil: 1 });
export const ProfessionalCredentialReview = model(
  'ProfessionalCredentialReview',
  credentialReviewSchema,
  'professionalCredentialReviews',
);

import { Types, type PipelineStage } from 'mongoose';
import type { z } from 'zod';
import { todayInIndia } from '../../shared/domain/healthcare.js';
import { DoctorAffiliation } from './provider.model.js';
import type { discoveryQuery } from './provider.validation.js';

export interface PublicDoctorListing {
  id: string;
  doctorId: string;
  slug: string;
  publicName: string;
  bio: string;
  organization: { id: string; name: string };
  facility: {
    id: string;
    name: string;
    kind: string;
    address?: unknown;
    contacts: Array<{ kind: string; value: string }>;
  };
  title: string;
  department: string;
  specialties: Array<{ id: string; code: string; name: string }>;
  qualifications: Array<{ name: string; institution: string; awardYear?: number }>;
  languages: string[];
  /** True when at least one active service offering exists; a hold still re-checks everything. */
  bookable: boolean;
  offerings: Array<{
    id: string;
    name: string;
    mode: string;
    durationMinutes: number;
    paymentPolicy: string;
    price?: { totalMinor: number; currency: string };
  }>;
  rating?: { average: number; count: number };
}

const join = (from: string, localField: string, as: string): PipelineStage[] => [
  { $lookup: { from, localField, foreignField: '_id', as } },
  { $unwind: `$${as}` },
];

/** One snapshot read; explicit public projection excludes residences, account IDs and evidence. */
export async function discoverDoctors(query: z.infer<typeof discoveryQuery>) {
  const now = new Date();
  const today = todayInIndia(now);
  const pipeline: PipelineStage[] = [
    {
      $match: {
        status: 'ACTIVE',
        validFrom: { $lte: now },
        $or: [{ validUntil: { $exists: false } }, { validUntil: { $gt: now } }],
        ...(query.before ? { _id: { $lt: new Types.ObjectId(query.before) } } : {}),
        ...(query.doctorId ? { doctorId: new Types.ObjectId(query.doctorId) } : {}),
        ...(query.organizationId
          ? { organizationId: new Types.ObjectId(query.organizationId) }
          : {}),
        ...(query.facilityId ? { facilityId: new Types.ObjectId(query.facilityId) } : {}),
      },
    },
    { $sort: { _id: -1 } },
    ...join('doctors', 'doctorId', 'doctor'),
    {
      $match: {
        'doctor.verificationStatus': 'VERIFIED',
        'doctor.profilePublished': true,
        'doctor.verifiedUntil': { $gt: now },
        ...(query.specialtyId
          ? { 'doctor.specialtyIds': new Types.ObjectId(query.specialtyId) }
          : {}),
      },
    },
    ...join('practitioners', 'doctor.practitionerId', 'practitioner'),
    { $match: { 'practitioner.status': 'ACTIVE', 'practitioner.profession': 'DOCTOR' } },
    ...join('users', 'practitioner.userId', 'account'),
    { $match: { 'account.isActive': true, 'account.isVerified': true } },
    ...join('organizations', 'organizationId', 'organization'),
    { $match: { 'organization.status': 'ACTIVE' } },
    ...join('facilities', 'facilityId', 'facility'),
    {
      $match: {
        'facility.status': 'ACTIVE',
        $expr: { $eq: ['$facility.organizationId', '$organizationId'] },
      },
    },
    ...join('doctorVerificationCases', 'doctor.verificationCaseId', 'review'),
    {
      $match: {
        'review.status': 'APPROVED',
        'review.validUntil': { $gt: now },
        $expr: {
          $and: [
            { $eq: ['$review.doctorId', '$doctorId'] },
            { $eq: ['$review.practitionerId', '$practitioner._id'] },
          ],
        },
      },
    },
    ...join('professionalRegistrations', 'review.registrationSnapshot.id', 'registration'),
    {
      $match: {
        'registration.status': 'VERIFIED',
        $expr: {
          $and: [
            { $eq: ['$registration.practitionerId', '$practitioner._id'] },
            { $eq: ['$registration.verificationCaseId', '$review._id'] },
            { $lte: [{ $ifNull: ['$registration.issuedOn', '0000-01-01'] }, today] },
            { $gte: [{ $ifNull: ['$registration.expiresOn', '9999-12-31'] }, today] },
          ],
        },
      },
    },
    {
      $lookup: {
        from: 'practitionerQualifications',
        let: {
          ids: '$review.qualificationSnapshots.id',
          caseId: '$review._id',
          practitionerId: '$practitioner._id',
        },
        pipeline: [
          {
            $match: {
              status: 'VERIFIED',
              $expr: {
                $and: [
                  { $in: ['$_id', '$$ids'] },
                  { $eq: ['$verificationCaseId', '$$caseId'] },
                  { $eq: ['$practitionerId', '$$practitionerId'] },
                ],
              },
            },
          },
          { $project: { _id: 1 } },
        ],
        as: 'currentQualifications',
      },
    },
    {
      $match: {
        $expr: {
          $and: [
            { $gt: [{ $size: '$currentQualifications' }, 0] },
            {
              $eq: [
                { $size: '$currentQualifications' },
                { $size: '$review.qualificationSnapshots' },
              ],
            },
          ],
        },
      },
    },
    {
      $lookup: {
        from: 'specialties',
        localField: 'doctor.specialtyIds',
        foreignField: '_id',
        pipeline: [{ $match: { status: 'ACTIVE' } }],
        as: 'specialties',
      },
    },
    {
      $match: {
        $expr: {
          $and: [
            { $gt: [{ $size: '$specialties' }, 0] },
            { $eq: [{ $size: '$specialties' }, { $size: '$doctor.specialtyIds' }] },
          ],
        },
      },
    },
    ...join('memberships', 'membershipId', 'membership'),
    {
      $match: {
        'membership.status': 'ACTIVE',
        'membership.validFrom': { $lte: now },
        $and: [
          {
            $or: [
              { 'membership.validUntil': { $exists: false } },
              { 'membership.validUntil': { $gt: now } },
            ],
          },
          {
            $expr: {
              $and: [
                { $eq: ['$membership.organizationId', '$organizationId'] },
                { $eq: ['$membership.userId', '$practitioner.userId'] },
                { $eq: ['$membership.validFrom', '$membershipValidFrom'] },
                {
                  $or: [
                    { $eq: ['$membership.facilityScope', 'ALL'] },
                    { $in: ['$facilityId', '$membership.facilityIds'] },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
    {
      $lookup: {
        from: 'roleAssignments',
        let: {
          membershipId: '$membershipId',
          userId: '$practitioner.userId',
          organizationId: '$organizationId',
        },
        pipeline: [
          {
            $match: {
              validFrom: { $lte: now },
              revokedAt: { $exists: false },
              $or: [{ validUntil: { $exists: false } }, { validUntil: { $gt: now } }],
              $expr: {
                $and: [
                  { $eq: ['$membershipId', '$$membershipId'] },
                  { $eq: ['$userId', '$$userId'] },
                  { $eq: ['$organizationId', '$$organizationId'] },
                ],
              },
            },
          },
          { $project: { roleId: 1 } },
        ],
        as: 'assignments',
      },
    },
    {
      $lookup: {
        from: 'roles',
        let: { ids: '$assignments.roleId', organizationId: '$organizationId' },
        pipeline: [
          {
            $match: {
              status: 'ACTIVE',
              permissionCodes: 'affiliations.accept',
              $expr: {
                $and: [
                  { $in: ['$_id', '$$ids'] },
                  { $eq: ['$organizationId', '$$organizationId'] },
                  { $eq: ['$scopeKey', { $concat: ['org:', { $toString: '$$organizationId' }] }] },
                ],
              },
            },
          },
          { $project: { _id: 1 } },
        ],
        as: 'practiceRoles',
      },
    },
    { $match: { 'practiceRoles.0': { $exists: true } } },
    { $limit: query.limit + 1 },
    {
      $lookup: {
        from: 'serviceOfferings',
        let: { affiliationId: '$_id' },
        pipeline: [
          {
            $match: {
              status: 'ACTIVE',
              $expr: { $eq: ['$doctorAffiliationId', '$$affiliationId'] },
            },
          },
          { $sort: { _id: 1 } },
          { $limit: 10 },
          {
            $lookup: {
              from: 'prices',
              localField: 'currentPriceId',
              foreignField: '_id',
              as: 'price',
            },
          },
          {
            $project: {
              _id: 0,
              id: { $toString: '$_id' },
              name: 1,
              mode: 1,
              durationMinutes: 1,
              paymentPolicy: 1,
              price: {
                $let: {
                  vars: { p: { $first: '$price' } },
                  in: { totalMinor: '$$p.totalMinor', currency: '$$p.currency' },
                },
              },
            },
          },
        ],
        as: 'offerings',
      },
    },
    {
      $lookup: {
        from: 'reviews',
        let: { doctorId: '$doctorId' },
        pipeline: [
          { $match: { status: 'PUBLISHED', $expr: { $eq: ['$doctorId', '$$doctorId'] } } },
          { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
        ],
        as: 'ratingSummary',
      },
    },
    {
      $project: {
        _id: 0,
        id: { $toString: '$_id' },
        doctorId: { $toString: '$doctorId' },
        slug: '$doctor.slug',
        publicName: '$doctor.publicName',
        bio: '$doctor.bio',
        organization: { id: { $toString: '$organizationId' }, name: '$organization.displayName' },
        facility: {
          id: { $toString: '$facilityId' },
          name: '$facility.name',
          kind: '$facility.kind',
          address: '$facility.address',
          contacts: {
            $map: {
              input: '$facility.publicContacts',
              as: 'contact',
              in: { kind: '$$contact.kind', value: '$$contact.value' },
            },
          },
        },
        title: 1,
        department: 1,
        languages: '$practitioner.languages',
        bookable: { $gt: [{ $size: '$offerings' }, 0] },
        offerings: 1,
        rating: {
          $let: {
            vars: { r: { $first: '$ratingSummary' } },
            in: {
              $cond: [
                { $ifNull: ['$$r', false] },
                { average: { $round: ['$$r.average', 1] }, count: '$$r.count' },
                '$$REMOVE',
              ],
            },
          },
        },
        specialties: {
          $map: {
            input: '$specialties',
            as: 'specialty',
            in: {
              id: { $toString: '$$specialty._id' },
              code: '$$specialty.code',
              name: '$$specialty.name',
            },
          },
        },
        qualifications: {
          $map: {
            input: '$review.qualificationSnapshots',
            as: 'qualification',
            in: {
              name: '$$qualification.qualificationName',
              institution: '$$qualification.institutionName',
              awardYear: '$$qualification.awardYear',
            },
          },
        },
      },
    },
  ];
  const rows = await DoctorAffiliation.aggregate<PublicDoctorListing>(pipeline)
    .readConcern('snapshot')
    .option({ maxTimeMS: 5000 });
  return {
    items: rows.slice(0, query.limit),
    nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : undefined,
  };
}

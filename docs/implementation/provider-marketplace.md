# Doctor verification, affiliations and public discovery

Implemented 24 November 2026 on top of the [healthcare foundation](foundation.md). This slice adds two collections (`doctorVerificationCases`, `doctorAffiliations`), independent manual doctor review, accepted provider affiliations and a public directory. There are now 21 healthcare collections in the initializer, alongside the existing identity models.

## Working workflow

1. An account creates its practitioner identity, doctor draft, academic declarations and council registration declaration. At least one active specialty and one qualification are required for submission.
2. The doctor selects its own registration and qualifications and submits a declaration. The case captures bounded, typed snapshots of identity, public profile and evidence references. The doctor enters `IN_REVIEW` and becomes unpublished.
3. An account with platform `doctors.verify` reads the private review case. The applicant and current colleagues at the same provider cannot decide it. Approval requires explicit identity, registration and qualification checks, a reason and a future review expiry no more than 366 days away or the registration's expiry, whichever comes first.
4. Approval marks the selected registration and qualifications verified, links them to the case, marks the doctor verified, and commits audit/outbox events in the same transaction. Duplicate verified registration identities fail the database uniqueness constraint and roll back the entire approval. Rejection/change requests return the doctor to an unpublished draft.
5. A verified provider administrator proposes a doctor/facility affiliation. The doctor must accept it personally while holding a current membership with `affiliations.accept` at that facility. Membership acceptance and affiliation acceptance are separate actions.
6. The doctor explicitly publishes the profile. Publication requires current verification, valid credentials and an active accepted affiliation. A solo doctor may own the provider and accept its own affiliation; doctor and provider verification still require an independent platform reviewer.
7. Anonymous clients query the directory. Listings represent a doctor at a facility, so one doctor can have multiple location entries. All eligibility checks run against current authoritative records in one snapshot aggregation. No search cache or expiry worker is needed to hide an expired/restricted listing.

Verification is a recorded **manual external review**, not an automated council lookup. Evidence references remain private identifiers/notes for an externally managed review process. Reviewers must reconcile council names, registration identifiers, applicant identity, specialties and source authenticity before attesting. The software does not establish those facts by checking a box. Dedicated private upload, malware scanning and evidence retention are still a separate implementation slice.

## State transitions and corrections

- Doctor: `UNVERIFIED -> IN_REVIEW -> VERIFIED` or back to `UNVERIFIED` after rejection/change requests. An owner can withdraw pending or approved verification to return to draft, which removes publication and current verification. Completed case history remains available.
- Identity name and birth date cannot change while a doctor is in review, verified or suspended. Withdraw first, correct the identity, then submit a new review. Personal contacts/residential addresses may be updated without altering the reviewed identity. Doctor public-profile edits remain limited to unverified drafts.
- A platform reviewer can suspend a doctor. Lifting suspension returns it to `UNVERIFIED`; it does not restore verification or publication. The doctor cannot bypass suspension by withdrawing.
- Affiliation: `PENDING -> ACTIVE` only through doctor acceptance; `PENDING -> REJECTED` through refusal; `ACTIVE <-> SUSPENDED` through provider management; nonterminal affiliations can end. Ending does not delete history. Renewals create a fresh invitation and acceptance.
- Invitations expire after seven days, and acceptance checks the deadline even without a background sweeper. Creating a replacement ends an expired pending invitation transactionally. Optional validity dates independently limit the affiliation itself.
- Affiliation acceptance captures the membership identifier and its original `validFrom`. Ending and re-inviting the same membership does not revive a previously accepted affiliation. The old affiliation must end and a fresh one be accepted.

## Eligibility and privacy

Publication/discovery check all of the following:

- Doctor status `VERIFIED`, unexpired review and verified-until dates; discovery additionally requires explicit publication.
- Active practitioner and verified, active login account.
- The current approved case belongs to the doctor and practitioner.
- Its registration remains verified, belongs to that practitioner/case and is within its issue/expiry dates.
- Every selected qualification remains verified against the current case, and all selected specialties are active.
- An active organization, active facility belonging to it and accepted affiliation within its validity period.
- The accepted membership is still active and from the same membership term, includes that facility, and has a current role assignment granting `affiliations.accept`.

Discovery explicitly projects public name, biography, reviewed qualification display labels, specialties, languages, affiliation title/department, provider display name, facility address and public contact values. It excludes residential addresses, private legal identity, birth date, account identifiers, private contacts, certificate/license numbers, evidence references and review notes. Public responses use `Cache-Control: no-store`.

Affiliation is a directory/provider relationship, not a grant of clinical record access or prescription privileges. Entries return `bookable: false` until services, scheduling and booking are implemented. No fees, availability or clinical privileges are inferred from the public profile.

## API additions

All paths use `/api/v1`. Mutations require the existing `Idempotency-Key` header. Existing rows require `expectedVersion`; GET `/doctors/me` now also returns `verificationCaseId` and `verifiedUntil`.

| Method    | Path                                                                      | Purpose                                        |
| --------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| POST, GET | `/doctors/me/verification-requests`                                       | Submit a draft / list own case history         |
| GET       | `/doctors/me/verification-requests/:reviewId`                             | Read own private case                          |
| POST      | `/doctors/me/withdraw-verification`                                       | Withdraw verification and unpublish            |
| POST      | `/doctors/me/publication`                                                 | Explicit publish/unpublish                     |
| GET       | `/doctors/me/affiliations`                                                | Own pending and historical affiliations        |
| POST      | `/doctors/me/affiliations/:affiliationId/respond`                         | ACCEPT/REJECT invitation                       |
| POST      | `/doctors/me/affiliations/:affiliationId/end`                             | Doctor ends its affiliation                    |
| POST, GET | `/organizations/:organizationId/doctor-affiliations`                      | Propose/list scoped affiliations               |
| POST      | `/organizations/:organizationId/doctor-affiliations/:affiliationId/state` | Provider suspends, resumes or ends             |
| GET       | `/platform/doctor-verifications`                                          | Pending review queue, `doctors.verify`         |
| GET       | `/platform/doctor-verifications/:reviewId`                                | Audited private review case, `doctors.verify`  |
| POST      | `/platform/doctor-verifications/:reviewId/decide`                         | Independent review decision                    |
| POST      | `/platform/doctors/:doctorId/restriction`                                 | Suspend or return a suspended doctor to draft  |
| GET       | `/discovery/doctors`                                                      | Anonymous filtered, paginated public directory |

Submission example:

```json
{
  "expectedVersion": 0,
  "registrationId": "<professional-registration ObjectId>",
  "qualificationIds": ["<qualification ObjectId>"],
  "declaration": "I attest that these submitted declarations are accurate."
}
```

Approval example; choose an actual future expiry within the permitted range:

```json
{
  "expectedVersion": 0,
  "decision": "APPROVED",
  "reason": "Identity and selected credentials checked against source evidence.",
  "validUntil": "2027-01-31T18:29:59Z",
  "checks": {
    "identityChecked": true,
    "registrationChecked": true,
    "qualificationsChecked": true
  }
}
```

Affiliation proposals contain `doctorId`, `facilityId`, `title`, `department`, optional ISO `validFrom` and `validUntil`. Respond with `{ "expectedVersion": 0, "decision": "ACCEPT" }`; publish with `{ "expectedVersion": <current doctor version>, "published": true }`.

Discovery accepts optional `doctorId`, `organizationId`, `facilityId`, `specialtyId`, `before`, and `limit` (1–25, default 10). Results are in descending affiliation identifier order; use `nextCursor` as `before`. Filtering and eligibility occur before pagination. This is a basic directory, without text/geo ranking, availability, prices or sponsored results. The aggregation has a five-second database deadline; assess query plans and load before a large public rollout.

## Setup and upgrade

Run `npm run db:setup` explicitly against the intended development/deployment database. No application database was migrated during implementation.

The initializer adds both collections/indexes and updates built-in global role definitions to include `doctors.verify`. Existing organization roles receive only the new capabilities: owner/administrator gain `affiliations.manage` and `affiliations.accept`; clinician gains `affiliations.accept`; receptionist/billing gain neither. This additive step touches built-in roles only, records audit/outbox events, and is idempotent. Custom platform reviewers need `doctors.verify` assigned through the existing role-management API.

Doctor reviews use a separate typed `doctorVerificationCases` collection while the earlier `verificationCases` retains provider-onboarding semantics. This avoids changing existing provider-case indexes and request contracts during an additive rollout. A future shared review queue can combine both types without losing their independent lifecycle rules.

## Verification and remaining work

Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration`, and `npm run build`.

The new replica-set suite verifies foreign-credential rejection, applicant/colleague review denial, identity freezing, private-case authorization, review replay, two-sided affiliation acceptance, public field projection, facility closure, ended/re-invited memberships, retained history, suspension/re-verification, duplicate verified-license rollback, credential expiry, cross-tenant management and permission migration idempotency. It uses synthetic data in isolated databases.

Remaining dependencies for a bookable marketplace are private evidence handling, reviewed credential correction/revocation tooling, services/prices, schedules/resource claims and booking. Clinical access/consent, prescriptions, payments, notifications and hospital operations retain their separate roadmap phases. The current directory and manually reviewed profile workflow are not a complete clinical or booking release.

# Healthcare foundation implementation

Implemented on 23 November 2026. This is the first executable slice of the [architecture roadmap](../architecture/08-operations-testing-and-roadmap.md), extending the existing Express/TypeScript backend. The wider hospital ecosystem remains phased work; the architecture's 135 target collections are not all implemented.

The 24 November extension adds [doctor review, accepted affiliations and public discovery](provider-marketplace.md), including the additive role upgrade and revised publication workflow. The later [platform modules](platform-modules.md) implement the booking, finance, documents, clinical, diagnostics, pharmacy, inpatient and operations slices; their status supersedes the next-slice list and the outbox note below.

## Included workflows

| Area                | Working behavior                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity            | Existing account registration, verification, login and sessions; every authenticated request now checks the current account status and global role                                                       |
| Provider onboarding | Create a hospital, clinic, solo practice, lab or pharmacy organization; bootstrap its owner and five organization roles; edit a draft; submit external evidence references for independent manual review |
| Facilities          | Create and list scoped facilities; edit draft/inactive facilities; activate only after organization approval; deactivate with a reason                                                                   |
| Staff               | Invite an existing verified account to an organization and selected facilities; target account accepts; suspend, reactivate or end membership                                                            |
| Patients            | Create and edit a self profile; request a dependent profile; independently review representative authority with expiry; revoke authority                                                                 |
| Reception           | Register a patient without a login; allocate an organization-specific MRN; list, read and correct only the provider's demographic snapshot                                                               |
| Patient portal      | List accessible profiles; explicitly register a self/authorized dependent profile at an active provider facility                                                                                         |
| Professionals       | Create and edit a private practitioner profile and unverified doctor draft; declare academic qualifications, employment with employer address, and council registrations                                 |
| Reliability         | Atomic business writes, audit events, outbox events and idempotency results; version checks on edits; unique indexes; cursor pagination                                                                  |

An organization owner is an organization administrator, not automatically a doctor. A doctor account may also have a patient profile. Patients do not need an account to receive a provider-local registration. Declaring a hospital in employment history does not grant membership or establish a verified doctor affiliation.

## Run locally

Run commands from `docduniya-backend`. Keep your existing `.env`; merge any needed settings from `.env.example`.

```powershell
npm ci
docker compose -f docker-compose.db.yml up -d --wait
```

The development database binds only to `127.0.0.1:27018` and runs a one-node replica set. Set the following URI in your local `.env`, or use your own replica-set connection:

```dotenv
MONGO_URI=mongodb://127.0.0.1:27018/docduniya?replicaSet=rs0&directConnection=true
```

```powershell
npm run db:setup
npm run dev
```

`db:setup` creates collections and their declared indexes, ensures existing platform roles and inserts six starter specialty labels using local codes. It does not drop indexes, wipe data, overwrite existing specialties, create demo accounts or resolve existing duplicate data. Run it explicitly before using healthcare endpoints. The local Docker configuration is development-only and is not a production deployment recipe.

All new healthcare models have `autoIndex: false` and `autoCreate: false`. Use a deployment identity with index-management privileges for setup. Use a separate restricted runtime database identity in production. MongoDB transactions require a replica set or sharded cluster; a standalone server is insufficient. See [Mongoose transactions](https://mongoosejs.com/docs/transactions.html).

## Collections and ownership

The new model registry is `src/database/foundation.ts`.

| Collection                   | Owner and key relationship                                                      |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `organizations`              | Provider tenant; references its owner account                                   |
| `facilities`                 | Organization-owned service location                                             |
| `verificationCases`          | Organization onboarding review; one pending submission per organization         |
| `memberships`                | Unique organization/account pair, status and facility scope                     |
| `roles`                      | Organization-scoped role definitions; distinct from legacy global `accessroles` |
| `roleAssignments`            | Membership/account/role binding with validity and revocation                    |
| `patients`                   | Global person identity; optional owner account, unique when present             |
| `patientRelationships`       | Reviewed representative authority; profile/registration actions only            |
| `patientRegistrations`       | Unique organization/patient pair, local MRN and demographic snapshot            |
| `practitioners`              | Private professional identity linked to an account                              |
| `doctors`                    | Doctor draft linked to practitioner; unpublished and unverified by default      |
| `specialties`                | Local navigation labels; no symptom-to-diagnosis mapping                        |
| `practitionerQualifications` | Academic declarations and evidence references                                   |
| `practitionerEmployment`     | Declared employment history, dates and workplace addresses                      |
| `professionalRegistrations`  | Council registration declarations and evidence references                       |
| `auditEvents`                | Mutation provenance and authorized sensitive reads                              |
| `outboxEvents`               | Minimal event envelopes committed with the corresponding mutation               |
| `idempotencyKeys`            | Actor/scope/operation/key plus request hash and minimal result                  |
| `numberSequences`            | Per-organization MRN counter, initialized with the organization                 |

Mutable aggregates carry `createdBy`, `updatedBy`, timestamps, `schemaVersion` and optimistic `version`. Operational records have purpose-specific metadata. Mongoose `ref` is not a foreign-key constraint: services check references and tenant scope explicitly.

Indexes enforce uniqueness in the database. In particular, the active role-assignment partial index uses equality to `null`, which also matches a missing revocation field; it does not use unsupported `$exists: false` in an index filter. See [MongoDB partial-index operators](https://www.mongodb.com/docs/manual/core/index-partial/).

## HTTP contract

Prefix: `/api/v1`. All healthcare routes require existing authentication except `GET /specialties`. Bearer tokens and the existing secure cookie mechanism are supported. Responses use `{ success: true, data: ... }`; mutations return `{ id, version }`. Creation endpoints may return 201 again on an idempotent replay. Error responses retain the existing `code`/`message` envelope. `X-Request-Id` correlates normal routed requests with audit and outbox records.

Every healthcare POST/PATCH requires `Idempotency-Key`: 8–100 ASCII letters, digits, hyphens or underscores. Use a new UUID per logical command; retry with the same key and body after a network failure. A different body with the same actor/scope/operation/key returns 409 `IDEMPOTENCY_CONFLICT`. Results are retained without TTL in this initial slice. Revoked access is checked before returning sensitive data; replayed commands return only the original identifier/version.

Updates include `expectedVersion`. Stale requests return 409 `VERSION_CONFLICT`. Profile updates replace the documented editable profile fields; they are not arbitrary MongoDB patches. Do not echo server-only fields such as `normalized`, address `id`, verification flags, actors or audit metadata into request DTOs. Unknown fields are rejected.

Lists accept `limit` (1–100, default 25) and `before` (the previous `nextCursor`). Patient registration lists additionally accept an exact `mrn`. No unscoped global patient search is provided.

| Method           | Path                                                                   | Authorization or behavior                                                                     |
| ---------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| POST             | `/organizations`                                                       | Authenticated account becomes owner of a draft                                                |
| GET, PATCH       | `/organizations/:organizationId`                                       | Membership; edits require organization-wide management and draft state                        |
| GET, POST        | `/organizations/:organizationId/facilities`                            | Scoped list / organization-wide creation                                                      |
| PATCH            | `/organizations/:organizationId/facilities/:facilityId`                | Facility management; draft/inactive only                                                      |
| POST             | `/organizations/:organizationId/facilities/:facilityId/state`          | Management; expected version, ACTIVE/INACTIVE, reason                                         |
| POST             | `/organizations/:organizationId/submit-verification`                   | Organization-wide submit permission                                                           |
| GET, POST        | `/organizations/:organizationId/memberships`                           | Organization-wide staff management                                                            |
| POST             | `/organizations/:organizationId/memberships/:membershipId/state`       | ACTIVE/SUSPENDED/ENDED; owner/self changes excluded                                           |
| GET              | `/me/memberships`                                                      | Current account's memberships and invitations                                                 |
| POST             | `/me/memberships/:membershipId/accept`                                 | Invited account only, before seven-day expiry                                                 |
| GET, POST        | `/organizations/:organizationId/patient-registrations`                 | Scoped demographic read / registration permissions                                            |
| GET, PATCH       | `/organizations/:organizationId/patient-registrations/:registrationId` | Same organization and allowed facility; corrections require reason                            |
| POST             | `/patients`                                                            | SELF or DEPENDENT; dependent starts pending review                                            |
| GET, PATCH       | `/patients/:patientId/profile`                                         | Patient owner or active authorized representative                                             |
| POST             | `/patients/:patientId/registrations`                                   | Patient authority, active organization and active facility                                    |
| GET              | `/me/patients`                                                         | Self and active authorized dependent profiles                                                 |
| GET              | `/me/patient-relationships`                                            | Current account's relationship request states                                                 |
| POST             | `/me/patient-relationships/:relationshipId/revoke`                     | Representative or patient owner                                                               |
| GET, POST, PATCH | `/practitioners/me`                                                    | Current account's private professional profile; profession changes need later review workflow |
| GET, POST        | `/practitioners/me/qualifications`                                     | Current practitioner's academic declarations                                                  |
| GET, POST        | `/practitioners/me/employment`                                         | Current practitioner's employment declarations                                                |
| GET, POST        | `/practitioners/me/registrations`                                      | Current practitioner's council declarations                                                   |
| GET, POST, PATCH | `/doctors/me`                                                          | Current doctor's unverified draft                                                             |
| GET              | `/specialties`                                                         | Public active specialty labels                                                                |
| GET              | `/platform/provider-verifications`                                     | `providers.verify`                                                                            |
| POST             | `/platform/provider-verifications/:verificationId/decide`              | Same permission; independent reviewer                                                         |
| GET              | `/platform/patient-relationship-requests`                              | `patient-relationships.verify`                                                                |
| POST             | `/platform/patient-relationship-requests/:relationshipId/decide`       | Same permission; independent reviewer and expiry                                              |

The strict request schemas live alongside each module in `*.validation.ts` and are the source of truth for field names, bounds and enums.

## Example onboarding sequence

1. Register, verify and sign in through the existing `/auth` workflow.
2. Create the organization with a fresh idempotency key:

```json
{
  "kind": "CLINIC",
  "legalName": "Example Clinic",
  "displayName": "Example Clinic",
  "slug": "example-clinic",
  "legalAddress": {
    "use": "WORK",
    "line1": "Example Road",
    "city": "Kolkata",
    "stateCode": "WB",
    "postalCode": "700001",
    "countryCode": "IN"
  },
  "contacts": [{ "kind": "PHONE", "value": "+919876543210", "use": "WORK" }]
}
```

3. Create a facility using `name`, uppercase `code`, `kind`, physical `address`, optional `timezone` and `publicContacts`. It starts DRAFT.
4. Submit the organization with `expectedVersion`, a `declaration` of at least 20 characters and nonempty `evidenceReferences`. These are references to externally reviewed evidence, not file uploads or verified documents.
5. A separate platform reviewer decides using `expectedVersion`, `decision` (`APPROVED`, `REJECTED`, `CHANGES_REQUIRED`) and `reason`. The owner, submitter and current affiliated members cannot review it. After approval, activate the facility with its current version and a reason.
6. Invite staff using an existing verified `userId`, an assignable `role`, and either `facilityScope: "ALL"` with `facilityIds: []` or `"SELECTED"` with explicit facility IDs. The target account must accept the invitation itself. This slice stores in-app invitations; it does not send invitation emails.

An authenticated patient's `POST /patients` body can start small:

```json
{
  "kind": "SELF",
  "profile": {
    "name": { "display": "Example Patient" },
    "birthDate": "2000-02-29",
    "administrativeSex": "UNKNOWN",
    "preferredLanguage": "en",
    "addresses": [],
    "contacts": [],
    "emergencyContacts": []
  }
}
```

An owner/receptionist registers a walk-in by posting `{ "facilityId": "...", "profile": { ... } }` to the provider registration endpoint. It creates an unclaimed patient identity and a provider-local snapshot atomically. A patient portal account instead posts `{ "organizationId": "...", "facilityId": "..." }` to its own patient registration endpoint. Matching or claiming an existing walk-in identity requires a future reviewed workflow; this API does not auto-link by phone or email.

## Access and persistence boundaries

- A platform administrator does not automatically receive organization membership, patient portal access or clinical access. Reviewer permissions expose their specific review queues only.
- Organization/facility scope comes from current memberships and role assignments, never from a client role claim. The current account role is reloaded instead of trusting stale JWT role claims.
- Patient profile access is separate from provider demographic snapshots. A local correction does not overwrite the global patient profile or another organization's snapshot.
- Representative authority allows specified profile/registration actions only. It is not medical consent, legal proof produced by software, or permission for clinical record access. Initial approval is a documented manual review with a mandatory expiry.
- Business changes and audit/outbox/idempotency records use one session transaction, with no external side effects inside it. Membership, representative and facility fences serialize relevant writes with revocation/deactivation.
- Audit model hooks reject ordinary updates/deletes and modifications of existing audit documents. A production append-only database role and tamper-resistant retention/export are still required; Mongoose hooks do not protect against raw database access.
- Outbox records remain PENDING. No worker, queue publisher, payment provider, SMTP notification or external integration is invoked by these foundation workflows.
- Evidence strings are not automatically trusted or fetched. Do not use the existing public assets/media endpoints for medical records or identity evidence. The dedicated quarantine/scanning/private-document pipeline is a subsequent module.

## Verification

```powershell
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
```

The default suite covers HTTP health/404 and strict DTO/persistence validation. Integration tests start a real temporary MongoDB 8.2.6 replica set through `mongodb-memory-server`, download the binary to ignored `.cache/mongodb` on the first run, and use synthetic accounts and records. The suite overrides the application database configuration and creates a random `docduniya_test_<uuid>` database. Cleanup only drops that exact test database and stops the replica set.

To use an already-running local replica set, set `TEST_MONGO_URI`. Only loopback `mongodb://` addresses are accepted; test code overrides the database name even if a URI names an existing database. The tests do not use the application's `.env` database.

Integration coverage includes concurrent idempotent onboarding, rollback of all related writes, append-only audit model enforcement, independent provider review, active facility enforcement, cross-tenant and facility isolation, invitation acceptance, membership suspension, patient snapshot isolation, stale edits, concurrent MRNs, guardian review/expiry/revocation, private professional declarations, stale JWT roles and disabled accounts. Unverified council declarations do not reserve a license number globally; duplicate declarations within one practitioner are rejected, and a separate partial index makes verified registrations unique.

## Next implementation slices

1. Private evidence documents, malware quarantine, reviewed professional credentials, verified doctor/facility affiliations, controlled profile publication and change review.
2. Services/pricing, schedules and exceptions, resource reservation, slot holds, booking/cancellation/rescheduling, idempotent expiry and provider discovery.
3. Care-team authorization, granular clinical consent, encounters, signed notes with amendments, observations, diagnoses and prescriptions.
4. Invoices, gateway webhook inbox/deduplication, payments/refunds/settlement, notification delivery and leased outbox dispatch.
5. Hospital modules from the roadmap: admissions/bed occupancy, nursing, laboratory/radiology, pharmacy/inventory, theatre, discharge and insurance workflows.

Production readiness also requires tested backup/restore, operational monitoring, audit retention, database-level controls, rate-limit infrastructure, private-file isolation, permission-change/denied-read auditing, ownership transfer, reviewed credential corrections, and completed India-specific privacy/consent processes. This foundation does not claim ABDM certification or complete regulatory compliance.

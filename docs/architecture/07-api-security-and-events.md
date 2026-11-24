# API contracts, authorization and events

## Common HTTP contract

Base path `/api/v1`. JSON requests use strict DTOs, UTC ISO timestamps, date-only strings for calendar dates, decimal strings for Decimal128, and `{minor,currency,exponent}` for money. Internal ObjectIds are serialized as strings. Clients never submit trusted audit actors, clinical authorship, verification state, tenant ownership or calculated totals.

Use cursor pagination with a stable timestamp/id tie-breaker; default 25, maximum 100. Search and list filters are allowlisted. Export is a separate authorized background job with row limits and audit. Avoid offsets for deep clinical history and audit feeds.

Mutating retries use `Idempotency-Key` scoped to actor, tenant and operation. Same key/same payload returns the original outcome; different payload returns `409 IDEMPOTENCY_CONFLICT`. Return `202 OPERATION_PENDING` with a status resource for unresolved external effects. Expected aggregate version is required via `If-Match` or a single standardized `expectedVersion` field; select one convention before OpenAPI generation.

Errors contain `code`, user-safe `message`, `requestId`, and optional field errors/retry metadata. Use `401` unauthenticated, `403` denied where disclosure is acceptable, `404` for protected resource nondisclosure, `409` business/concurrency conflict, `422` domain validation and `429` rate limit. A payment failure is not necessarily an HTTP failure; return the durable payment state.

## Route families

These are the intended command/query surface. OpenAPI files and controllers are deliberately deferred until the design is accepted.

| Routes                                                                                                                                                | Authorized actor and purpose                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /auth/register`, `/verify`, `/login`, `/refresh`, `/logout`, `/logout-all`, `/password-reset`, `/mfa/verify`                                    | Public challenges or authenticated account lifecycle, with rate limits and replay protection   |
| `GET /me`, `/me/sessions`, `/me/memberships`, `/me/patients`; `DELETE /me/sessions/:id`                                                               | Account owner; no chart access implied by membership listing                                   |
| `POST /organizations`; `GET/PATCH /organizations/:id`                                                                                                 | Applicant creates draft; authorized provider admin manages their org                           |
| `POST /organizations/:id/submit-verification`; `/platform/verifications/:id/decide`                                                                   | Provider submission; separate platform verifier decision                                       |
| `/organizations/:id/facilities`, `/departments`, `/memberships`, `/role-assignments`                                                                  | Provider administration restricted to granted role/facility scope                              |
| `/practitioners/me`, `/doctors/me`, `/qualifications`, `/employment`, `/registrations`                                                                | Practitioner owner for declarations; verification and privileges require reviewer commands     |
| `/organizations/:id/doctor-affiliations`, `/service-offerings`, `/prices`, `/schedules`, `/schedule-exceptions`                                       | Scoped provider operator; professional activation checks                                       |
| `GET /specialties`, `/clinical-concepts`; `POST /discovery/search`; `GET /doctors/:slug`, `/facilities/:id`, `/offerings/:id/availability`            | Public approved fields only; sensitive concern search uses POST and redacted logs              |
| `POST /patients`; `/patients/:id/relationships`; `/organizations/:id/patient-registrations`                                                           | Self/guardian or registration staff; no arbitrary global patient enumeration                   |
| `GET/PATCH /patients/:id/profile`; `POST /patients/:id/intakes`; `/intakes/:id/submit`                                                                | Patient/verified representative; submitted snapshot ownership enforced                         |
| `POST /appointments/holds`; `/appointments/:id/confirm`, `/cancel`, `/reschedule`, `/check-in`, `/start`, `/complete`, `/discontinue`                 | Individual command policies; no generic status patch                                           |
| `GET /appointments/:id`; `GET /me/appointments`; `/organizations/:id/appointments`; `/queues`                                                         | Authorized participant or facility operations; minimum patient details                         |
| `POST /visits`; `POST /encounters`; `/encounters/:id/finish`; `GET /patients/:id/clinical-summary`, `/timeline`                                       | Care team with purpose/custody grant; encounters can start without appointment                 |
| `/encounters/:id/notes`, `/diagnoses`, `/observations`, `/service-orders`; `/clinical-records/:type/:id/sign`, `/amend`, `/mark-error`                | Authorized clinician with valid privileges; controlled allowlist of resource types             |
| `POST /prescriptions`; `/prescriptions/:id/items`; `/prescriptions/:id/sign`, `/prescription-items/:id/stop`                                          | Prescriber; pharmacist may view authorized signed items, not alter prescription                |
| `POST /documents/upload-intents`; `/documents/:id/complete-upload`; `/documents/:id/access`                                                           | Authorized custodian/subject; completion only schedules authoritative verification/scan        |
| `/patients/:id/consents`; `/consents/:id/withdraw`; `/patients/:id/access-grants`; `/privacy-requests`                                                | Verified authority; grants constrained by supported policy/legal basis                         |
| `/invoices/:id/issue`; `/payment-intents`; `/refunds`; `/credit-notes`; `/settlements/:id/approve`; `/reconciliations`                                | Finance authority scoped to merchant/entity; step-up/dual approval thresholds                  |
| `/organizations/:id/subscriptions`; `/subscription-plans`; `/provider-contracts`                                                                      | Commercial admin; feature entitlements do not grant medical access                             |
| `/admissions`, `/bed-assignments`, `/transfers`, `/discharge-plans`; `/specimens`, `/diagnostic-reports`; `/dispenses`, `/stock-movements`; `/claims` | Separate hospital roles and complete module workflows                                          |
| `/reviews`; `/support-tickets`; `/conversations/:id/messages`                                                                                         | Verified participants; privacy moderation, restricted support access                           |
| `/webhooks/payments/:connection`, `/webhooks/notifications/:connection`, `/integrations/:connection/inbox`                                            | Authenticated providers/services; raw signature or partner security protocol, not browser auth |
| `/platform/audit-events`; `/organizations/:id/audit-events`; `/patients/:id/access-history`                                                           | Distinct scoped audit views; investigative access logged                                       |

Admin exports, bulk edits, migrations and worker operations use the same policy/invariant layer. A separate `/admin` prefix is not a security mechanism.

## Critical command specifications

| Command                | Input                                                                                                                   | Checks / atomic effect                                                                                                                                                                            | Result / conflicts                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Hold appointment       | `patientId`, `offeringId`, `slotId` or accepted time interval, `quoteVersion`, `acceptedPolicyVersion`, optional intake | Verify representative, local registration, active provider, credential and affiliation; lock all resource/day anchors; create claims, HELD appointment, history, outbox and durable retry outcome | `appointmentId`, version, server expiry, final price, payment preparation state; `SLOT_UNAVAILABLE`, `QUOTE_CHANGED`, `PROVIDER_NOT_ELIGIBLE` |
| Confirm appointment    | appointment ID and expected version; no client `paid:true`                                                              | Live hold token/expiry, resources still owned, payment policy satisfied by trusted capture or allowed offline policy                                                                              | CONFIRMED; `HOLD_EXPIRED`, `PAYMENT_NOT_READY`, `VERSION_CONFLICT`                                                                            |
| Reschedule             | appointment ID, expected version, target offering/slot, accepted quote/policy                                           | Lock old/new resources, validate both scopes, keep booking version stable, release/create claims, append history and billing adjustment obligation                                                | New version and required payment/refund action; old slot retained on transaction failure                                                      |
| Sign record            | allowed resource type/ID, expected version, attestation, optional step-up proof                                         | Validate author/privileges, draft completeness, source identity, child versions; seal typed revision/signature and outbox                                                                         | Immutable revision ID/hash; `CREDENTIAL_INVALID`, `INCOMPLETE_RECORD`, `VERSION_CONFLICT`                                                     |
| Request refund         | payment ID, amount, reason, source credit/booking, operation key                                                        | Verify refundable amount and approvals; atomically reserve amount and create refund obligation                                                                                                    | Refund operation status; no fabricated success before gateway confirmation                                                                    |
| Finalize dispense      | prescription ID, item/batch/quantity list, expected versions                                                            | Check signed order, remaining/refill quantities, pharmacist role, expiry/recall, units, nonnegative stock; write dispense/movements/charges/outbox                                                | Dispense record; stock or prescription conflict rolls back all effects                                                                        |
| Transfer bed           | admission ID, current assignment/version, target bed, reason                                                            | Validate hospital/location and suitability; transaction ends old assignment and creates new, updates status and audit                                                                             | New assignment; duplicate active bed index -> `BED_UNAVAILABLE`                                                                               |
| Download clinical file | document ID, exact version or current, purpose                                                                          | Authenticate, patient/custody relationship, grant/basis, current consent, availability and hold policy; durable audit issuance                                                                    | Short-lived version-specific URL or streamed access; no access if scan pending                                                                |

All externally submitted IDs are validated through a server query. A correct ObjectId shape is not proof of ownership. This addresses [OWASP broken object-level authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/).

## Role and relationship policy

Every decision combines **permission + active scope + resource relationship + purpose/legal basis + state**. Feature entitlement is an additional commercial check where applicable. It never replaces the others.

| Principal                | Permitted baseline                                                                     | Explicit limits                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Patient                  | Own profile, appointments, released records, sharing preferences                       | Cannot alter provider-authored signed clinical facts                                           |
| Guardian/representative  | Actions named in a verified time-bounded relationship                                  | Not every family member and not indefinite after authority changes                             |
| Doctor                   | Assigned/authorized care, notes, diagnosis, orders and prescriptions within privileges | No cross-provider global chart browsing; no prescriptions after relevant credential suspension |
| Nurse                    | Assigned patient chart, vitals, nursing documentation, administration                  | Prescribing/signing restricted by actual professional privileges                               |
| Receptionist             | Local registration, demographics needed for operations, queue and appointments         | No routine full clinical chart or sensitive narrative access                                   |
| Laboratory professional  | Accepted orders/specimens/results and required context                                 | No unrelated patient history; verification/signing privilege separately assigned               |
| Pharmacist               | Authorized prescription, relevant allergy/context, dispense and stock                  | Cannot rewrite prescriber's signed order                                                       |
| Finance staff            | Invoices, payment, refunds/claims and minimum identity                                 | No unrestricted clinical narrative; claims disclosure limited by purpose                       |
| Provider admin           | Facilities, staff, offerings and operational configuration                             | Administration alone grants no clinical access                                                 |
| Platform verifier        | Provider identity, credential evidence and review decisions                            | No general patient chart access                                                                |
| Platform support         | Ticket-specific booking/payment context with masking                                   | Chart access requires a separate justified policy path                                         |
| Privacy/security officer | Scoped audit, privacy request and investigation workflows                              | Access itself audited; export requires explicit purpose                                        |
| Platform super admin     | Platform configuration and privileged identity administration                          | No automatic medical superuser or invisible impersonation                                      |
| Worker/integration       | Fixed purpose, org and resource scopes                                                 | No generic all-tenant service credential for every job                                         |

Emergency access is a separate step-up command with reason, named patient, short expiry, durable audit and mandatory review. It is available only to eligible clinical roles under the provider's approved policy. It does not bypass unavailable credentials, object scanning, or make the platform a medical decision-maker.

## Security and privacy controls

- Retain current secure session design only after its multi-role adaptation is reviewed. Verify session/security version, rotate refresh tokens atomically, revoke on credential reset, support MFA for privileged staff, and provide recovery procedures.
- Hash passwords with a reviewed adaptive algorithm/cost; preserve valid existing hashes during migration and rehash on authenticated upgrade. OTPs are short-lived, rate-limited and atomically consumed. OIDC account linking requires verified issuer/subject, not matching email alone.
- Use least-privilege fields in each response, encryption for restricted identifiers, TLS and storage encryption, managed secrets and key rotation. Determine which fields need application-level encryption based on threat model and query needs.
- Protect cookie-based mutations against CSRF; configure trusted origins, cookies and proxy trust deliberately. Rate-limit login, patient lookup, discovery, holds, messaging, file upload and exports by actor/tenant/IP as appropriate.
- Do not put health concern text, clinical narratives, phone numbers, JWTs, OTPs, document URLs or payment secrets into logs/traces. Remove query/body data from telemetry unless explicitly allowlisted.
- Consent caches use current versions and immediate invalidation. Security-critical reads fail closed if policy state cannot be established; emergency access has its own durable audit path rather than an unlogged fallback.
- File grants are version-specific. Keep quarantine and available objects inaccessible to public bucket policies. Downloads use safe disposition and content types; disallow active content execution and validate archive expansion limits.
- Record URL issuance in the application and actual object access in storage logs. Issuance is not proof of download; bearer URL sharing cannot be completely prevented once issued.
- Audit writes are in the business transaction when possible. Sensitive read/export authorization persists audit evidence before disclosure; an independent secure spool/collector is a designed availability option, never best-effort console logging.
- Use dedicated public projections and aggregate analytics. De-identification requires a reviewed method; merely removing names does not guarantee anonymity. No production PHI in developer fixtures.

Policy documents, retention controls and incident handling must follow the jurisdiction register. This design provides mechanisms; it does not declare compliance certification. FHIR itself does not provide these security controls. [FHIR security](https://hl7.org/fhir/R4/security.html).

## Event catalog and delivery

Event envelope: `eventId`, `type`, `eventSchemaVersion`, `occurredAt`, `organizationId?`, `aggregateType`, `aggregateId`, `aggregateVersion`, `actor`, `correlationId`, `causationId?`, and an allowlisted typed payload. Use references and required routing data, not whole charts. Event payload contracts are versioned independently of MongoDB document schemas.

| Event                                    | Producer    | Consumers / effects                                                      |
| ---------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| ProviderVerified / ProviderSuspended     | Provider    | Search refresh, booking eligibility worklist, notification               |
| AffiliationActivated / CredentialExpired | Provider    | Availability refresh, affected appointment tasks                         |
| AppointmentHeld                          | Booking     | Payment order preparation, expiry scheduling                             |
| AppointmentConfirmed / Rescheduled       | Booking     | Reminder recalculation, provider queue projection                        |
| AppointmentCancelled / Expired           | Booking     | Refund obligation if captured, notification, availability projection     |
| EncounterFinished                        | Clinical    | Documentation completion tasks, draft charge projection                  |
| ClinicalRecordSigned / Amended           | Clinical    | PDF generation, authorized patient release, external export queue        |
| DiagnosticReportFinalized                | Diagnostics | Result review task; critical classification routes escalation            |
| PrescriptionSigned / ItemStopped         | Prescribing | Authorized pharmacy/patient notification and medication review           |
| PaymentCaptured                          | Payments    | Guarded allocation/confirmation saga, ledger, reconciliation             |
| RefundSucceeded / SettlementPaid         | Payments    | Finance journals/receipts, provider/customer notification                |
| ConsentWithdrawn / GrantRevoked          | Privacy     | Cache invalidation, cancel pending exports, sharing connector revocation |
| DocumentAvailable / Rejected             | Documents   | Notify permitted requester; link availability updates                    |
| AdmissionTransferred / Discharged        | Hospital    | Bed/housekeeping work queue, care handoff and billing actions            |
| DispenseCompleted / StockAdjusted        | Pharmacy    | Charges, replenishment, finance integration                              |
| SubscriptionChanged                      | Commerce    | Entitlement projection, renewal/administrative tasks                     |

Consumers commit their effect and processedEvents marker together. Out-of-order projection events apply only a newer source version, or trigger a fresh aggregate read. Reminder jobs recheck current appointment status/time/version before sending. Retry with exponential backoff and jitter; bound attempts, then a dead-letter/work queue with owner and replay controls. Published events remain for a chosen replay horizon.

Webhook receiver verifies the raw body and signature before accepting source identity, durably inserts the deduplicated inbox row, then acknowledges. If persistence fails, return a retryable error; do not acknowledge and lose the event. Workers validate amount, currency, merchant and legal transition. If evidence conflicts, fetch authoritative provider status and queue reconciliation. [Razorpay webhook validation and ordering](https://razorpay.com/docs/webhooks/validate-test/).

## Interoperability contract

| Internal model                                      | Typical FHIR R4 boundary                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Patient / local registration                        | Patient plus scoped identifiers                                                                          |
| Practitioner / affiliation                          | Practitioner / PractitionerRole                                                                          |
| Organization / facility / location                  | Organization / Location / HealthcareService                                                              |
| Appointment / schedule / slot                       | Appointment / Schedule / Slot                                                                            |
| Visit / encounter / admission                       | Encounter with grouping/partOf according to the selected profile; admission maps hospitalization details |
| Conditions / diagnoses                              | Condition with encounter and verification context                                                        |
| Allergies / observations                            | AllergyIntolerance / Observation                                                                         |
| Prescription items                                  | One MedicationRequest per medication; document/group linkage preserves prescription                      |
| Medication statements / dispenses / administrations | MedicationStatement / MedicationDispense / MedicationAdministration                                      |
| Service orders / specimens / reports                | ServiceRequest / Specimen / DiagnosticReport                                                             |
| Documents / signed clinical export                  | DocumentReference or profiled Composition/Bundle as required                                             |
| Consent / audit / signatures                        | Consent / AuditEvent / Provenance with applicable security mechanisms                                    |
| Coverage / claims                                   | Coverage / Claim / ClaimResponse under actual payer/NHCX profile                                         |

Inbound data is authenticated, schema/profile validated, mapped through an anti-corruption adapter, deduplicated and assigned local custody/provenance. Unknown codes or ambiguous identities go to review. Do not silently overwrite local clinician-authored records with external updates. ABDM requires actual integration/certification workflows and partner version agreement; matching a table of resource names is not sufficient.

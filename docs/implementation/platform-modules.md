# Booking, finance, clinical, hospital and operations modules

Implemented 24 November 2026 on top of the [foundation](foundation.md) and [provider marketplace](provider-marketplace.md) slices, following the [architecture](../architecture/README.md). This document describes what each module does, the guarantees it enforces, how to configure and run it, and what it deliberately does not claim.

All conventions from the foundation still apply: base path `/api/v1`, `{ success, data }` envelopes, `Idempotency-Key` on every command, `expectedVersion` on every change to an existing record, strict DTOs that reject unknown fields, cursor pagination (`before`, `limit`), audit and outbox records written in the same transaction as the business change, and `404` for resources outside the caller's authority.

## Module map

| Module                            | Folder                                        | Collections                                                                                                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Services, schedules, reservations | `modules/scheduling`                          | `resources`, `serviceOfferings`, `prices`, `scheduleRules`, `scheduleExceptions`, `resourceCalendarDays`, `resourceClaims`                                                                                                                                                   |
| Booking and queue                 | `modules/appointments`                        | `appointments`, `appointmentEvents`, `queueEntries`                                                                                                                                                                                                                          |
| Billing and ledger                | `modules/billing`                             | `merchantAccounts`, `chargeItems`, `invoices`, `invoiceItems`, `creditNotes`, `payments`, `paymentAllocations`, `refunds`, `paymentDisputes`, `ledgerAccounts`, `ledgerJournals`, `reconciliationRuns`, `reconciliationItems`                                                |
| Payments (Razorpay)               | `modules/payments`                            | `paymentIntents`, `inboxEvents`                                                                                                                                                                                                                                              |
| Access                            | `modules/access`                              | role assignments for existing members; additive role upgrade                                                                                                                                                                                                                 |
| Private documents                 | `modules/documents`                           | `documents`, `documentVersions`, `documentLinks`                                                                                                                                                                                                                             |
| Privacy and consent               | `modules/privacy`                             | `policyVersions`, `policyAcknowledgements`, `consents`, `consentEvents`, `accessGrants`, `privacyRequests`, `retentionHolds`                                                                                                                                                 |
| Clinical records                  | `modules/clinical`                            | `visits`, `encounters`, `careTeamAssignments`, `allergies`, `conditions`, `medicationStatements`, `immunizations`, `observations`, `clinicalNotes`, `diagnoses`, `prescriptions`, `prescriptionItems`, `clinicalRevisions`, `recordSignatures`, `clinicalTasks`, `referrals` |
| Diagnostics                       | `modules/diagnostics`                         | `diagnosticTestCatalog`, `serviceOrders`, `specimens`, `diagnosticReports`, `imagingStudies`                                                                                                                                                                                 |
| Facility locations                | `modules/locations`                           | `facilityLocations`                                                                                                                                                                                                                                                          |
| Inpatient care                    | `modules/inpatient`                           | `admissions`, `bedAssignments`, `medicationAdministrations`, `fluidBalanceEntries`, `dischargePlans`                                                                                                                                                                         |
| Pharmacy and stock                | `modules/pharmacy`                            | `drugCatalog`, `inventoryItems`, `suppliers`, `stockBatches`, `stockBalances`, `stockMovements`, `purchaseOrders`, `goodsReceipts`, `dispenses`                                                                                                                              |
| Notifications and events          | `modules/notifications`, `modules/operations` | `notificationTemplates`, `notifications`, `processedEvents` (plus existing `outboxEvents`)                                                                                                                                                                                   |
| Support and reviews               | `modules/engagement`                          | `supportTickets`, `reviews`                                                                                                                                                                                                                                                  |
| Provider subscriptions            | `modules/commerce`                            | `subscriptionPlans`, `subscriptions`                                                                                                                                                                                                                                         |
| Professional credentials          | `modules/practitioners`                       | `professionalCredentialReviews`                                                                                                                                                                                                                                              |
| Two-factor sign-in                | `modules/admin/auth/mfa`                      | `mfaFactors`, `mfaChallenges`                                                                                                                                                                                                                                                |
| Intake and concern routing        | `modules/intake`                              | `questionnaires`, `questionnaireAssignments`, `intakeResponses`, `concernMappings`                                                                                                                                                                                           |
| Waitlist                          | `modules/appointments`                        | `waitlistEntries`                                                                                                                                                                                                                                                            |
| Secure messaging                  | `modules/messaging`                           | `conversations`, `conversationMessages`                                                                                                                                                                                                                                      |
| Patient identity merge            | `modules/patients`                            | `patientMergeCases` (plus merge fields on `patients`)                                                                                                                                                                                                                        |
| Insurance and claims              | `modules/insurance`                           | `payers`, `insuranceCoverages`, `preauthorizations`, `insuranceClaims`, `claimInvoices`                                                                                                                                                                                      |
| Theatre and procedures            | `modules/procedures`                          | `procedureCases`, `theatreLocks`                                                                                                                                                                                                                                             |

The collection registry is `src/database/foundation.ts`; `npm run db:setup` creates every collection and index listed there.

## Roles and permissions

Organization roles gain the codes needed by the new modules (`src/modules/access/access.constants.ts`). **Owner and administrator roles receive administration only, never clinical permissions.** Built-in roles:

| Role                     | Purpose                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `owner`, `administrator` | Facilities, staff, roles, services, schedules, billing, merchant, stock, procurement, inpatient operations, subscriptions, audit |
| `receptionist`           | Registration, demographics, appointments, queue, view bills, collect payments                                                    |
| `clinician`              | Chart read/write, signing, prescribing, ordering diagnostics, recording provider consents, documents                             |
| `nurse`                  | Chart read/write, nursing documentation, inpatient operations, queue                                                             |
| `lab-technician`         | Diagnostics worklist, specimens, results and verification                                                                        |
| `pharmacist`             | Dispensing, inventory, procurement                                                                                               |
| `billing`                | Invoices, payments, refunds, ledger                                                                                              |

`POST /organizations/:id/memberships/:membershipId/role-assignments` grants an additional role to an active member. Only a solo-practice owner may grant roles to themselves, for example a solo doctor taking the `clinician` role. Clinical actions still require the person's own professional profile and, for prescribing, a current verified doctor credential.

New platform permissions are `merchants.verify`, `catalog.manage`, `commerce.manage`, `support.manage`, `reviews.moderate`, `privacy.manage`, `audit.read`, `operations.manage`, `professionals.verify` (non-doctor credential review) and `patient-identity.manage` (duplicate merges). The super-admin role receives them automatically.

`db:setup` runs an **additive** upgrade for organizations created earlier. It creates the new built-in roles and adds missing template permissions to built-in roles. It never removes a permission or edits custom roles, and it records an audit and outbox event for each change.

## Workflows and guarantees

### Services, schedules and booking

- A service offering belongs to an active, verified doctor affiliation. Activation requires a published price; published prices are immutable. Schedules are weekly IST windows with a step; doctor leave (`/doctors/me/time-blocks`) blocks the doctor's global practitioner calendar across every provider and flags affected bookings with `requiresReassignment`.
- **Reservation protocol:** a hold ensures calendar-day anchor documents exist, then in one transaction writes every touched resource/day anchor in sorted order, checks for overlapping active claims (practitioner, rooms/devices and the patient) and creates token-bound claims. Concurrent holds for one interval therefore produce exactly one success; the others get `409 SLOT_UNAVAILABLE`. `HELD` claims block only until their expiry; no TTL index releases anything.
- Holds carry a quote (`offeringVersion` + `priceId`); a changed quote returns `409 QUOTE_CHANGED`. Pay-at-provider and free services are confirmed by the patient or staff; **prepaid services are confirmed only by a verified payment capture** (`409 PAYMENT_NOT_READY` otherwise).
- Explicit commands: confirm, cancel, reschedule, check-in, no-show, start, complete, discontinue. Start, complete and discontinue require clinical permission **and** being the assigned verified doctor. Check-in creates the local registration if needed and allocates an atomic facility/day queue token. Reschedule keeps the booking identity and swaps claims atomically. Every transition appends to `appointmentEvents`.
- The public quote (`GET /offerings/:id`) and availability (`GET /offerings/:id/availability?date=`) are estimates; the hold re-checks everything. Discovery now reports `bookable`, active offerings with prices, and moderated ratings.

### Billing, Razorpay and the ledger

- **Merchant onboarding:** a provider registers its Razorpay key id with `env:RAZORPAY_*` references to the key secret and webhook secret (never the secrets themselves). An independent platform reviewer (`merchants.verify`, not a member of that provider) activates it; activation fails closed if the deployment lacks the referenced secrets.
- **Prepaid booking:** `POST /appointments/:id/payment-intents` creates one intent per hold, with the amount taken from the accepted price snapshot. The Razorpay order is created after commit. Preparation is durable worker work: each attempt takes a persisted lease before any network call, always looks the order up by receipt first, and checks amount and currency. A process that dies after committing the intent, or after Razorpay created the order but before the local write, is recovered by the worker without a second order. Expired intents with no order are cancelled; inactive merchants and repeated failures go to `RECONCILE`.
- **Webhook:** `POST /webhooks/payments/razorpay/:merchantAccountId` verifies the HMAC over the exact raw bytes before parsing. It stores a deduplicated inbox row containing only identifiers (never card, email or contact fields), acknowledges, then processes. Duplicate or reordered deliveries are harmless. The checkout callback (`POST /payment-intents/:id/verify`) verifies the checkout signature and then fetches the payment from Razorpay; the client never supplies the amount.
- **Capture processing** confirms only the matching, still-valid hold. It then issues the invoice and allocates the payment, all in one transaction with balanced journals. A capture that arrives after expiry or cancellation is recorded faithfully, marks the appointment `refundRequired`, and reserves a full refund. It never revives the booking.
- **Invoices:** drafts from appointment price snapshots, manual lines or unbilled charges (for example from dispensing). Issuing assigns a never-reused `INV/<fiscal-year>/<n>` number and posts receivables. Issued invoices are corrected only with credit notes; only drafts can be discarded.
- **Invariants** (enforced in model validation and in each command):
  - Payments: `captured ≥ allocated + refunded + refundReserved`.
  - Invoices: `credited + allocated ≤ total`.
- **Refunds** reserve funds before any network call. They are sent with Razorpay's refund idempotency key and completed exactly once. Unknown outcomes stay `PROCESSING` and retry with the same key. Offline (cash/bank) refunds complete immediately.
- **Cancellation** of a prepaid booking applies the refund share from the cancellation policy snapshot taken at booking (full refund when the provider cancels). It issues a credit note, reverses the allocation and reserves the refund in the same transaction. A refund failure never reverses the cancellation.
- **Offline receipts** (cash, bank transfer, cheque, UPI offline) get `RCPT-` numbers and can be allocated to an invoice in the same command.
- **Ledger:** a minimal chart of accounts (cash, gateway clearing, receivables, unapplied receipts, tax payable, revenue). Journals are append-only, balanced and idempotent per operation key. `GET /organizations/:id/ledger/trial-balance` recomputes from journals.
- **Reconciliation** compares Razorpay payments in a period of up to seven days with local captures, recording `MATCHED`, `MISSING_LOCAL`, `MISSING_PROVIDER` and `MISMATCH` items. Resolving a missing local capture re-fetches it and applies it through the normal path. Dispute webhooks create `paymentDisputes`.

### Private documents

- `POST /documents/upload-intents` authorizes custody and creates a pending document with a presigned PUT URL bound to the key, content type and exact length. Custody is one of: the patient (patient uploads), the organization (clinical documents, which need a care relationship) or the user (practitioner credential evidence).
- `complete-upload` is only a hint: the server checks that the stored object exists and that its size and type match, then quarantines it. The scanner worker reads the bytes, checks the file signature against the declared type, scans with ClamAV (`clamd` INSTREAM), hashes with SHA-256, writes **the exact scanned bytes** (never a copy of the still-writable upload key) to a new immutable available key with a create-only condition, records a `documentVersions` entry and deletes the quarantine object. A mismatch or malware rejects the document. **No configured scanner means files stay quarantined.**
- `POST /documents/:id/access` re-authorizes on every request, writes the audit record **before** issuing a 60-second, version-specific, `attachment` download URL, and returns the content hash.
  - The patient's own uploads are readable by the patient.
  - Provider documents are readable by the treating team, and by the patient once released.
  - Another provider can read them under a current patient consent grant, only within the grant's record period and purposes, and only by that provider's treating clinicians (clinical permission, local registration and care relationship). The recipient's administrators are never clinical recipients.
  - Credential evidence is readable by the owner and by a credential reviewer for a linked review case.
- Clinical documents use a separate private bucket (`PRIVATE_DOCUMENTS_BUCKET`). Startup refuses to treat the public media bucket as clinical storage.

### Clinical records

- **Access rule:** organization permission, plus facility scope, plus the patient's local registration, plus a current care relationship. A care relationship is either a care-team assignment (created when a clinician starts an encounter, when the care team adds a colleague, or when a theatre team is scheduled) or a reviewed emergency grant. Care assignments are bound to the member's current membership: a revoked and re-granted membership does not revive old assignments. Receptionists, administrators and platform staff cannot read charts. Unrelated colleagues get `404`.
- **Facility rule:** a member restricted to selected facilities reaches only records held at those facilities. The same filter applies to individual reads and to summaries, timelines, encounter lists and diagnostics lists, so an aggregate never shows what an individual read refuses. Every clinical record stores its facility; organization-wide members see the organization's longitudinal chart.
- **Starting care needs arrival evidence:** a checked-in appointment, a walk-in queue entry recorded by the front desk today (`queueEntryId`), an open visit, an existing care relationship or reviewed emergency access. Otherwise `409 ARRIVAL_REQUIRED`: a clinician cannot open an encounter for an unrelated patient to gain chart access. Admission requests follow the same rule. Remote encounters also require the patient's recorded telemedicine consent. Visits group encounters.
- **Facts** (allergies, conditions, medication statements, immunizations, observations) save an immutable revision on every confirmed change. The summary reports allergy status as `UNKNOWN` unless allergies are recorded or a signed note says none are known.
- **Signing:** notes, diagnoses and prescriptions. Signing requires a **current credential**: a doctor's verified registration and eligible affiliation at the record's facility, or an approved, unexpired professional credential for other professions. A suspended or lapsed credential blocks new signatures immediately (`403 CREDENTIAL_INVALID`). Signing then checks the author, the expected draft version and completeness, then seals a typed canonical-JSON snapshot with a SHA-256 hash in `clinicalRevisions` and an attestation in `recordSignatures`. Revisions and signatures are append-only at the model layer.
  - Signed notes change only by amendment (a new signed revision) or by an addendum.
  - Any record can be marked entered-in-error with a reason; the original content is kept.
- **Prescriptions:** signing requires a currently verified doctor with an eligible affiliation at the encounter facility. It assigns an `RX-` number, snapshots the prescriber's registration and seals every item in the signed snapshot. Items are stopped individually; the signed prescription is never rewritten.
- **Patient portal** (`GET /patients/:id/clinical-records`): signed prescriptions, released notes, recorded allergies, active problems, immunizations and visit history across providers. Drafts are never shown.
- **Sharing** (`GET /organizations/:id/patients/:patientId/shared-records?resourceType=`): another provider sees signed or final records only under a current consent grant for that record family and period. Withdrawal takes effect on the next request.
- Tasks support follow-up, result review and critical results. Acknowledgement and completion are separate facts. Critical-result tasks cannot be cancelled. Unacknowledged tasks escalate on a schedule. Referrals transfer responsibility, not records.

### Diagnostics

A clinician places an order on an encounter; placing it seals a signed revision. The laboratory then:

1. Accepts the order from its worklist. The worklist shows MRN, name and date of birth, not the chart.
2. Collects a specimen with an atomic accession number and a random barcode, then receives or rejects it.
3. Enters results as preliminary observations. Each result is validated against its order, its received specimen and the patient.
4. Verifies the report, which finalizes the observations, seals the report and creates a result-review task for the ordering clinician. A critical interpretation creates a `CRITICAL_RESULT` task instead.

Amendments create new revisions, keep the original values and alert the orderer again. Patients see only verified reports. Imaging studies are registered as PACS references; no images are stored or transformed.

### Pharmacy, stock and procurement

- Stock is held per batch and location in integer stock units. Every change is an append-only movement. Balance updates use non-negative predicates, so a race for the last unit lets exactly one dispense succeed (`409 STOCK_UNAVAILABLE`).
- **Procurement:**
  - A purchase order needs approval from a second staff member before it is ordered.
  - Receipts cannot exceed the ordered quantity.
  - Received goods enter **quarantine**; a pharmacist's quality release moves them to dispensable stock.
  - Recalled or expired batches cannot be dispensed.
  - Transfers post paired movements.
- **Branch scope:** every stock effect (dispense lines, adjustments, transfers, purchase-order destinations, batch release) is authorized at the facility that holds the location, and dispense lines must use a location of the dispensing pharmacy. Balance and low-stock views are limited to the member's facilities.
- **Dispensing:** requires a pharmacist with a current approved credential, a signed and unexpired prescription from the same organization, an active item, and a released, unexpired batch of the matching item. A substitution needs permission and a reason. The cumulative quantity may not exceed `quantity × (1 + refills)`. A possible match with an active drug allergy requires a recorded pharmacist override. Dispensing creates a charge item for billing.
- Returns go to quarantine (never straight back to saleable stock) and restore the remaining prescription quantity.
- Supply and administration are separate facts: dispensing updates `fulfillmentStatus` (`UNFILLED`, `PARTIAL`, `FULFILLED`) and never ends the medication order. A fully dispensed item stays administrable until it is stopped or its prescription lapses.

### Inpatient care

- **Admission:** a clinician requests an admission, which opens an inpatient or emergency visit. Bed assignment is the occupancy authority, and partial unique indexes allow only one active assignment per bed and per admission. Concurrent assignment of one bed lets exactly one succeed (`BED_UNAVAILABLE`). Gender-restricted beds are checked.
- **Transfers** end the old assignment, start the new one and update both bed states in one transaction. Vacated beds go to `CLEANING`.
- **Nursing documentation** (requires care-team membership): medication administration against signed, unexpired, active items, by a professional with a current credential, where `GIVEN` needs the actual time, dose, unit and route and other statuses need a reason; corrections as linked entered-in-error events; fluid intake and output with 24-hour totals; vitals as observations.
- **Discharge:** a discharge plan with a checklist. The signed discharge summary and medicine reconciliation are required; optional waivers need a reason. Clinical discharge, physical departure (which frees the bed and closes the visit) and financial status are separate.

### Notifications, events and workers

- **Outbox relay:** leases pending events and runs each consumer in a transaction together with a `processedEvents` marker, so replays are harmless. Failures back off with jitter; after ten attempts an event is marked `FAILED` and can be replayed by an operator (`/platform/outbox`).
- **Notification consumer:**
  - **In-app and email:** booking confirmations, cancellations, reschedules and refunds; new-record notices to patients; invitations.
  - **In-app only:** task alerts to clinicians.
  - **Delivery rules:** templates are versioned and variables allowlisted. External messages carry no clinical narrative. Reminders recheck the appointment's state and time before sending.
- `npm run worker` runs every background job:
  - outbox relay
  - payment inbox
  - hold expiry
  - refunds
  - pending payment orders
  - notifications
  - document scanning and expiry of abandoned uploads
  - task escalation
  - batch expiry
  - subscription renewal
  - waitlist offers
  - doctor credential sweep (flags future appointments of suspended or lapsed doctors for reassignment)
  - professional credential expiry
- Every job is safe to run on several instances at once.

### Support, reviews and subscriptions

- **Support tickets:** due times by category (safety tickets are urgent), replies, and assignment, resolution and closure by platform support. A linked patient never grants chart access.
- **Reviews:** only the patient side of a completed appointment can review it, once. Reviews are moderated before publication, providers may reply, and public listings show "Verified patient" only. Ratings feed discovery.
- **Subscriptions:**
  - Plans are versioned, and each provider has at most one current subscription.
  - Unpaid periods move to `PAST_DUE`, then to `SUSPENDED` after a seven-day grace period; payment is recorded by platform finance.
  - Entitlements are commercial limits only and never block record access, safety work or export.

### Privacy and audit

- Policies are versioned and immutable; acknowledgements are recorded.
- Record-sharing consent creates a scoped, expiring access grant with an append-only event history. Withdrawal revokes grants immediately.
- Provider-recorded consent covers telemedicine and procedures.
- Emergency access lasts four hours for doctors or nurses at a provider where the patient is registered. It is audited and must be reviewed by someone else within 72 hours.
- Privacy requests (access, export, correction, erasure, grievance) are due in 30 days. Erasure respects retention holds.
- `GET /patients/:id/export` returns a machine-readable export of the patient's own data.
- Audit views are scoped by organization, platform and patient. The patient view shows which providers accessed the record, not individual staff identities.

### Professional credentials and two-factor sign-in

- **Non-doctor credentials:** nurses, pharmacists, laboratory and allied professionals submit a declared registration (`POST /professionals/me/credential-reviews`). An independent platform reviewer (`professionals.verify`, not a colleague at the applicant's providers) approves with completed checks and an expiry of at most one year, never beyond the registration. Approval verifies the exact registration version reviewed. Suspension takes effect immediately; the worker expires lapsed approvals. Signing, dispensing, result verification and medication administration require a current credential.
- **Doctor suspension** also places the doctor's upcoming appointments on the reassignment worklist (`requiresReassignment`), the same flag doctor leave uses; a worker sweep covers verifications that lapse by date.
- **Two-factor sign-in (TOTP):** `POST /auth/mfa/totp/enroll` returns a secret and `otpauth://` URI; `POST /auth/mfa/totp/activate` proves possession, issues ten single-use recovery codes and signs out every other session. Afterwards password or Google sign-in returns `{ mfaRequired, challengeToken }` instead of a session; `POST /auth/mfa/verify` completes it with a code or a recovery code. Challenges last five minutes, allow five attempts and are single use; a code cannot be replayed within its window. Secrets are sealed with AES-256-GCM (`MFA_ENCRYPTION_KEY`).
- **Administrator portal:** platform staff (any role granting platform permissions) sign in only through `POST /auth/admin/login` and `POST /auth/admin/verify`. Every sign-in emails a six-digit code (bcrypt-hashed in `adminSignInChallenges`, 10 minutes, five attempts, single use, one email per minute, three per attempt; a newer sign-in supersedes older attempts). The account is re-checked when the code is entered, and an enrolled authenticator is still required afterwards. `POST /auth/login` and `POST /auth/google` refuse staff accounts with `403 ADMIN_LOGIN_REQUIRED`; non-staff accounts at the portal receive the same answer as a wrong password. The frontend serves the portal at `/administrator/login`.
- **Enforcement:** with `MFA_ENFORCE_PRIVILEGED=true`, platform review functions and privileged organization administration (organization management, memberships, role assignment, merchant, refunds, ledger, audit) return `403 MFA_ENROLLMENT_REQUIRED` until the user has enrolled. Because sign-in always demands an enrolled factor, every session of an enrolled user passed the second step.

### Intake questionnaires and concern routing

- Providers (or the platform, as templates) author versioned questionnaires: yes/no, single and multiple choice, text, number and date questions, simple conditions (`enableWhen`) and red-flag answers. Publishing seals a content hash; published versions never change. A published questionnaire is attached to a service offering (`PUT /organizations/:id/offerings/:offeringId/questionnaire`), and `GET /offerings/:id/questionnaire` shows it publicly.
- The patient (or a representative with medical authority) answers before the visit (`POST /appointments/:id/intake`). Answers are validated against the exact version: unknown, duplicate, inapplicable, mistyped or missing required answers are rejected. Red flags are recorded and the patient is told to seek urgent care. Resubmission supersedes the previous response.
- Intake is health information: the appointment's clinician or the patient's care team reads it (audited) and marks it reviewed. Administration alone never sees it.
- **Concern routing** maps patient-described concerns to specialties and an urgency (`ROUTINE`, `URGENT`, `EMERGENCY`). Mappings are proposed and approved by two different platform reviewers. `GET /discovery/concerns?q=` searches them and `POST /discovery/route` returns ranked specialties for discovery. Any emergency concern returns emergency advice and `bookable: false`. Routing suggests which kind of doctor to see; it never diagnoses.

### Waitlist

- A patient joins the waitlist for a service and date range (one active entry per service). The worker offers the earliest free slot to the longest-waiting patient; a partial unique index guarantees one open offer per slot across worker instances. The patient is notified in-app and by email.
- An offer lasts 30 minutes and reserves nothing. Accepting places a normal hold at the current price, so payment, confirmation and cancellation follow the booking rules. If the slot was taken meanwhile, the patient returns to the queue. Unaccepted offers return to the queue up to three times; entries whose range has passed expire.

### Secure messaging

- Patients message providers they are registered with; providers message their registered patients. `CARE` threads carry health information and are visible to the patient side and to the appointment's clinician or the patient's care team (reads audited). `ADMINISTRATIVE` threads (scheduling, billing) are handled by the front desk.
- Messages are append-only and limited to 4,000 characters and five attached documents of the same patient. Patients see which side wrote, never individual staff identities. A new provider message notifies the patient without including its content.

### Patient identity merge

- A patient claiming a record a provider created for them, or a provider holding both registrations, requests a merge with evidence. An independent platform reviewer (`patient-identity.manage`) approves with identity checks. Only unclaimed records merge: an account owner's identity is never absorbed into another account.
- Approval marks the duplicate `MERGED` and lists it on the survivor. Nothing is deleted and every provider's records keep their original references. The patient portal, verified reports and export include records held under merged identities.

### Insurance and claims

- Payers (insurers, TPAs, government schemes, corporate) are a platform catalog. Patients record their own policies, or billing staff record them for registered patients.
- **Pre-authorization:** billing staff submit a request against a current policy and record the payer's decision (approved, partially approved or denied, never above the request).
- **Claims:** issued invoices of one patient, each on at most one open claim (unique index), for no more than their outstanding balance or an approved pre-authorization. Adjudication records the approved and disallowed amounts; denial releases the invoices.
- **Settlement:** the payer's remittance becomes an `INSURANCE` receipt (cash or bank debit, unapplied-receipts credit) allocated to the claim's invoices, so the ledger stays balanced. The disallowed remainder stays on the invoice as the patient's responsibility.

### Theatre and procedures

- The treating clinician (with a current credential) requests a procedure from an encounter, optionally linked to an admission. Theatre coordination (`inpatient.manage`) books a theatre location: concurrent bookings serialize on a per-theatre lock and overlaps return `409`. The team (surgeon, assistant, anaesthetist, scrub and circulating nurses) is assembled and each member gets a care relationship.
- The WHO Surgical Safety Checklist runs in order: **sign-in** and **time-out** before the surgeon starts, **sign-out** before completion. Each phase must confirm every required item and is recorded by a team member. Only the surgeon starts and completes the case; completion may link a procedure note of the encounter.
- The theatre board shows times, theatre and status only; clinical detail requires chart access.

## Configuration

New settings (see `.env.example`):

| Variable                                               | Meaning                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `PRIVATE_DOCUMENTS_BUCKET`, `PRIVATE_DOCUMENTS_REGION` | Private clinical document bucket; must differ from `AWS_S3_BUCKET`. Uses the standard AWS credential chain |
| `PRIVATE_DOCUMENT_MAX_MB`                              | Upload limit (default 20)                                                                                  |
| `CLAMAV_HOST`, `CLAMAV_PORT`                           | ClamAV `clamd` endpoint; without it documents stay quarantined                                             |
| `RAZORPAY_API_BASE`                                    | Razorpay API base URL                                                                                      |
| `RAZORPAY_*`                                           | Merchant secrets referenced by `env:NAME` from merchant accounts                                           |
| `PAYMENT_HOLD_MINUTES`                                 | How long a prepaid hold waits for capture (default 15)                                                     |
| `WORKER_POLL_MS`                                       | Base worker cadence (default 5000)                                                                         |
| `MFA_ENCRYPTION_KEY`                                   | 32-byte base64 key sealing TOTP secrets; required in production                                            |
| `MFA_ENFORCE_PRIVILEGED`                               | Require an enrolled authenticator for privileged administration (default `false`)                          |

Configure the Razorpay dashboard webhook URL as `https://<api-host>/api/v1/webhooks/payments/razorpay/<merchantAccountId>` with events `payment.captured`, `payment.authorized`, `order.paid`, `payment.failed`, `refund.processed`, `refund.failed` and `payment.dispute.*`.

## Run and verify

```powershell
npm run db:setup        # collections, indexes, role upgrade, notification templates
npm run dev             # API
npm run worker          # background jobs (separate process)
npm run openapi         # write docs/api/openapi.json
npm run typecheck; npm run lint; npm test; npm run test:integration; npm run build
```

`db:setup` was **not** run against the configured application database during implementation, and the worker was not started against it either, because the worker would deliver real notifications. Run `db:setup` deliberately against the intended database.

Integration suites run on a temporary MongoDB 8.2.6 replica set with synthetic data, a fake Razorpay gateway, an in-memory private store and a stub scanner:

| Suite                              | Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `booking-payments.test.ts`         | 12 concurrent holds → one success; quote change; pay-at-provider through queue token, doctor-only start, completion, invoice, cash receipt and balanced ledger; merchant self-approval refused; forged webhook rejected; duplicate and differently identified webhooks deduplicated; no PII in the inbox; capture confirms booking and issues an allocated invoice; cancellation refund with credit note; capture after expiry becomes a refund obligation; late-cancellation share from the policy snapshot                                                                                                              |
| `clinical-care.test.ts`            | Receptionist, admin and unrelated colleague denied; allergy `UNKNOWN` by default; signed note immutable; amendment keeps the original revision; hash verification; diagnosis and prescription signing with registration snapshot; patient sees signed and released records only; outbox notifications; emergency access with independent review; consent-scoped sharing and withdrawal; access history; export; diagnostics order → accept → specimen → critical result → verify → non-cancellable critical task → acknowledgement → amendment with preserved values; single invitation notification across relay replays |
| `hospital-operations.test.ts`      | PO second-person approval; over-receipt refused; quarantine and release; allergy override; quantity limit; concurrent last-stock dispense → one success; return to quarantine; charge to invoice; location hierarchy rules; concurrent bed assignment → one success; atomic transfer; care-team gate for nursing; medication administration validation and correction; fluid totals; discharge checklist requires a signed summary; clinical discharge vs departure; document upload verification, signature sniffing, malware rejection, audited short-lived access; subscription uniqueness, grace and suspension       |
| `api-surface.test.ts`              | Public catalogs with `no-store`; `401` for private routes; idempotency key required; unknown fields rejected; other tenants hidden; patient portal and export over HTTP; generated OpenAPI contract; unsigned webhook rejected                                                                                                                                                                                                                                                                                                                                                                                            |
| `verification-regressions.test.ts` | The eight defects of the [verification review](../reviews/implementation-verification-2026-11-24.md#resolution) plus the walk-in self-assignment weakness, each as an attack that must fail and a legitimate path that must work                                                                                                                                                                                                                                                                                                                                                                                          |
| `mfa.test.ts`                      | Enrollment, activation, second-step sign-in, code replay refused, single-use recovery codes and challenges, enforcement for administrators                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `platform-extensions.test.ts`      | Intake validation, red flags and clinician-only access; two-person concern governance and emergency routing; waitlist offers without double-offering, acceptance and lapsed offers; messaging access by thread kind; identity merge review; insurance claim limits, single open claim, settlement and balanced ledger; theatre overlap and checklist order                                                                                                                                                                                                                                                                |

## What this does not claim

- **External services are not activated.**
  - Live Razorpay merchant onboarding, production webhook delivery and settlement have not been exercised against a real account.
  - ClamAV and the private bucket must be provisioned.
  - ABDM, FHIR exchange, LIS/PACS, SMS and video integrations remain adapter boundaries.
- **Business decisions are still open.**
  - Payment collection and settlement for the marketplace commission (D03/D04) is not implemented.
  - Platform-collected subscription invoicing waits on the commercial model; platform finance records subscription payments.
  - Exact cancellation windows, specialty rules and telemedicine prescribing limits are configuration defaults pending clinical and legal approval.
- **Credentials and signatures have known limits.**
  - Credential reviews record what a reviewer checked; they are not live registry lookups with councils.
  - Signatures are authenticated attestations, not legally recognized digital signatures.
- **Clinical scope is incomplete.**
  - Nursing assessment scales, care plans, safety incidents, formulary policy, stock reservations and the specialist modules in [the hospital dictionary](../architecture/05-data-model-hospital.md) are not implemented.
  - Insurance exchange with payers is manual entry of payer decisions and remittances; no payer or TPA integration exists.
  - Concern routing and intake red flags are governed navigation aids, not triage or clinical decision support. Medication and allergy checks are data checks.
- **Production readiness is not established.** MFA enforcement is off by default and must be enabled with an encryption key. Backup and restore drills, monitoring, append-only database roles, load tests and clinical, privacy and legal acceptance are still required before production use.

## API contract

The machine-readable OpenAPI 3.1 contract is generated from the mounted routers, so it always matches the served API (342 paths, 404 operations):

- `GET /api/v1/openapi.json` serves it at runtime: operations, path parameters, authentication and the shared envelopes.
- `npm run openapi` writes the full version to [docs/api/openapi.json](../api/openapi.json) and the readable [API reference](../frontend/api-reference.md). The generator (`src/scripts/openapi.ts`, `src/scripts/api-docs/`) reads the route sources with the TypeScript compiler, finds the Zod schema each handler applies to `req.body`, `req.query` and path parameters (including `validate(...)` middleware and controllers), and evaluates it in its own module, so the documented schema is the exact instance the server validates with. It also records whether the handler requires an `Idempotency-Key`, the permission codes in its service code path, and the status enumerations of every model.

Frontend developers start from the [frontend integration guide](../frontend/README.md): conventions, sign-in, navigation by role and permission, and the screen-by-screen workflows.

`GET /me/workspaces` returns the caller's current provider memberships with organization, facility scope, roles and effective permissions, plus pending invitations, so the interface can build its navigation without guessing. `GET /me/patients` marks the account's own profile with `self: true`.

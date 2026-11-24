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

New platform permissions are `merchants.verify`, `catalog.manage`, `commerce.manage`, `support.manage`, `reviews.moderate`, `privacy.manage`, `audit.read` and `operations.manage`. The super-admin role receives them automatically.

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
- **Prepaid booking:** `POST /appointments/:id/payment-intents` creates one intent per hold, with the amount taken from the accepted price snapshot. The Razorpay order is created after commit. A timeout leaves the intent `ORDER_PENDING`, and the worker retries after first looking the order up by receipt.
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
- `complete-upload` is only a hint: the server checks that the stored object exists and that its size and type match, then quarantines it. The scanner worker reads the bytes, checks the file signature against the declared type, scans with ClamAV (`clamd` INSTREAM), hashes with SHA-256, copies the exact bytes to an immutable available key, records a `documentVersions` entry and deletes the quarantine object. A mismatch or malware rejects the document. **No configured scanner means files stay quarantined.**
- `POST /documents/:id/access` re-authorizes on every request, writes the audit record **before** issuing a 60-second, version-specific, `attachment` download URL, and returns the content hash.
  - The patient's own uploads are readable by the patient.
  - Provider documents are readable by the treating team, and by the patient once released.
  - Another provider can read them under a current patient consent grant.
  - Credential evidence is readable by the owner and by a credential reviewer for a linked review case.
- Clinical documents use a separate private bucket (`PRIVATE_DOCUMENTS_BUCKET`). Startup refuses to treat the public media bucket as clinical storage.

### Clinical records

- **Access rule:** organization permission, plus facility scope, plus the patient's local registration, plus a current care relationship. A care relationship is either a care-team assignment, created when a clinician starts an encounter or is added by the care team, or a reviewed emergency grant. Receptionists, administrators and platform staff cannot read charts. Unrelated colleagues get `404`.
- Encounters can start without an appointment (walk-ins). Remote encounters require the patient's recorded telemedicine consent. Visits group encounters.
- **Facts** (allergies, conditions, medication statements, immunizations, observations) save an immutable revision on every confirmed change. The summary reports allergy status as `UNKNOWN` unless allergies are recorded or a signed note says none are known.
- **Signing:** notes, diagnoses and prescriptions. Signing checks the author, the expected draft version and completeness, then seals a typed canonical-JSON snapshot with a SHA-256 hash in `clinicalRevisions` and an attestation in `recordSignatures`. Revisions and signatures are append-only at the model layer.
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
- **Dispensing:** requires a pharmacist, a signed and unexpired prescription from the same organization, an active item, and a released, unexpired batch of the matching item. A substitution needs permission and a reason. The cumulative quantity may not exceed `quantity × (1 + refills)`. A possible match with an active drug allergy requires a recorded pharmacist override. Dispensing creates a charge item for billing.
- Returns go to quarantine (never straight back to saleable stock) and restore the remaining prescription quantity.

### Inpatient care

- **Admission:** a clinician requests an admission, which opens an inpatient or emergency visit. Bed assignment is the occupancy authority, and partial unique indexes allow only one active assignment per bed and per admission. Concurrent assignment of one bed lets exactly one succeed (`BED_UNAVAILABLE`). Gender-restricted beds are checked.
- **Transfers** end the old assignment, start the new one and update both bed states in one transaction. Vacated beds go to `CLEANING`.
- **Nursing documentation** (requires care-team membership): medication administration against signed active items, where `GIVEN` needs the actual time, dose, unit and route and other statuses need a reason; corrections as linked entered-in-error events; fluid intake and output with 24-hour totals; vitals as observations.
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

Configure the Razorpay dashboard webhook URL as `https://<api-host>/api/v1/webhooks/payments/razorpay/<merchantAccountId>` with events `payment.captured`, `payment.authorized`, `order.paid`, `payment.failed`, `refund.processed`, `refund.failed` and `payment.dispute.*`.

## Run and verify

```powershell
npm run db:setup        # collections, indexes, role upgrade, notification templates
npm run dev             # API
npm run worker          # background jobs (separate process)
npm run typecheck; npm run lint; npm test; npm run test:integration; npm run build
```

`db:setup` was **not** run against the configured application database during implementation, and the worker was not started against it either, because the worker would deliver real notifications. Run `db:setup` deliberately against the intended database.

Integration suites run on a temporary MongoDB 8.2.6 replica set with synthetic data, a fake Razorpay gateway, an in-memory private store and a stub scanner:

| Suite                         | Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `booking-payments.test.ts`    | 12 concurrent holds → one success; quote change; pay-at-provider through queue token, doctor-only start, completion, invoice, cash receipt and balanced ledger; merchant self-approval refused; forged webhook rejected; duplicate and differently identified webhooks deduplicated; no PII in the inbox; capture confirms booking and issues an allocated invoice; cancellation refund with credit note; capture after expiry becomes a refund obligation; late-cancellation share from the policy snapshot                                                                                                              |
| `clinical-care.test.ts`       | Receptionist, admin and unrelated colleague denied; allergy `UNKNOWN` by default; signed note immutable; amendment keeps the original revision; hash verification; diagnosis and prescription signing with registration snapshot; patient sees signed and released records only; outbox notifications; emergency access with independent review; consent-scoped sharing and withdrawal; access history; export; diagnostics order → accept → specimen → critical result → verify → non-cancellable critical task → acknowledgement → amendment with preserved values; single invitation notification across relay replays |
| `hospital-operations.test.ts` | PO second-person approval; over-receipt refused; quarantine and release; allergy override; quantity limit; concurrent last-stock dispense → one success; return to quarantine; charge to invoice; location hierarchy rules; concurrent bed assignment → one success; atomic transfer; care-team gate for nursing; medication administration validation and correction; fluid totals; discharge checklist requires a signed summary; clinical discharge vs departure; document upload verification, signature sniffing, malware rejection, audited short-lived access; subscription uniqueness, grace and suspension       |
| `api-surface.test.ts`         | Public catalogs with `no-store`; `401` for private routes; idempotency key required; unknown fields rejected; other tenants hidden; patient portal and export over HTTP; unsigned webhook rejected                                                                                                                                                                                                                                                                                                                                                                                                                        |

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
  - Only doctors have a credential-review workflow. Nurses, pharmacists and laboratory professionals act on their recorded profession and organization role.
  - Signatures are authenticated attestations, not legally recognized digital signatures.
- **Clinical scope is incomplete.**
  - Waitlists, theatre and procedure cases, insurance and claims, nursing assessment scales and the specialist modules in [the hospital dictionary](../architecture/05-data-model-hospital.md) are not implemented.
  - Medication and allergy checks are data checks, not clinical decision support.
- **Production readiness is not established.** Backup and restore drills, monitoring, MFA for privileged staff, append-only database roles, load tests and clinical, privacy and legal acceptance are still required before production use.

## Route catalog

Generated from the registered routers. All paths are under `/api/v1`. Request schemas live next to each module in `*.validation.ts` and are the source of truth for fields, bounds and enums.

### Booking and scheduling

| Method | Path                                                                     |
| ------ | ------------------------------------------------------------------------ |
| POST   | `/organizations/:organizationId/resources`                               |
| GET    | `/organizations/:organizationId/resources`                               |
| POST   | `/organizations/:organizationId/service-offerings`                       |
| GET    | `/organizations/:organizationId/service-offerings`                       |
| POST   | `/organizations/:organizationId/service-offerings/:offeringId/prices`    |
| POST   | `/organizations/:organizationId/service-offerings/:offeringId/state`     |
| POST   | `/organizations/:organizationId/schedules`                               |
| GET    | `/organizations/:organizationId/schedules`                               |
| POST   | `/organizations/:organizationId/schedules/:scheduleId/state`             |
| POST   | `/doctors/me/time-blocks`                                                |
| POST   | `/doctors/me/time-blocks/:blockId/cancel`                                |
| GET    | `/offerings/:offeringId`                                                 |
| GET    | `/offerings/:offeringId/availability`                                    |
| POST   | `/appointments/holds`                                                    |
| GET    | `/me/appointments`                                                       |
| GET    | `/appointments/:appointmentId`                                           |
| POST   | `/appointments/:appointmentId/confirm`                                   |
| POST   | `/appointments/:appointmentId/cancel`                                    |
| POST   | `/appointments/:appointmentId/reschedule`                                |
| POST   | `/organizations/:organizationId/appointments/holds`                      |
| GET    | `/organizations/:organizationId/appointments`                            |
| GET    | `/organizations/:organizationId/appointments/:appointmentId`             |
| POST   | `/organizations/:organizationId/appointments/:appointmentId/confirm`     |
| POST   | `/organizations/:organizationId/appointments/:appointmentId/cancel`      |
| POST   | `/organizations/:organizationId/appointments/:appointmentId/reschedule`  |
| POST   | `/organizations/:organizationId/appointments/:appointmentId/check-in`    |
| POST   | `/organizations/:organizationId/appointments/:appointmentId/no-show`     |
| POST   | `/organizations/:organizationId/appointments/:appointmentId/start`       |
| POST   | `/organizations/:organizationId/appointments/:appointmentId/complete`    |
| POST   | `/organizations/:organizationId/appointments/:appointmentId/discontinue` |
| POST   | `/organizations/:organizationId/queue`                                   |
| GET    | `/organizations/:organizationId/queue`                                   |
| POST   | `/organizations/:organizationId/queue/:entryId/transition`               |

### Billing, payments and ledger

| Method | Path                                                                  |
| ------ | --------------------------------------------------------------------- |
| POST   | `/organizations/:organizationId/merchant-accounts`                    |
| GET    | `/organizations/:organizationId/merchant-accounts`                    |
| GET    | `/platform/merchant-accounts`                                         |
| POST   | `/platform/merchant-accounts/:merchantId/decide`                      |
| POST   | `/organizations/:organizationId/invoices`                             |
| GET    | `/organizations/:organizationId/invoices`                             |
| GET    | `/organizations/:organizationId/invoices/:invoiceId`                  |
| POST   | `/organizations/:organizationId/invoices/:invoiceId/issue`            |
| POST   | `/organizations/:organizationId/invoices/:invoiceId/discard`          |
| POST   | `/organizations/:organizationId/invoices/:invoiceId/credit-notes`     |
| GET    | `/organizations/:organizationId/charges`                              |
| POST   | `/organizations/:organizationId/payments/offline`                     |
| GET    | `/organizations/:organizationId/payments`                             |
| GET    | `/organizations/:organizationId/payments/:paymentId`                  |
| POST   | `/organizations/:organizationId/payments/:paymentId/allocations`      |
| POST   | `/organizations/:organizationId/payments/:paymentId/refunds`          |
| GET    | `/organizations/:organizationId/payment-disputes`                     |
| GET    | `/organizations/:organizationId/ledger/journals`                      |
| GET    | `/organizations/:organizationId/ledger/trial-balance`                 |
| POST   | `/organizations/:organizationId/reconciliations`                      |
| GET    | `/organizations/:organizationId/reconciliations/:runId`               |
| POST   | `/organizations/:organizationId/reconciliation-items/:itemId/resolve` |
| POST   | `/appointments/:appointmentId/payment-intents`                        |
| GET    | `/payment-intents/:intentId`                                          |
| POST   | `/payment-intents/:intentId/verify`                                   |
| GET    | `/patients/:patientId/invoices`                                       |
| GET    | `/patients/:patientId/invoices/:invoiceId`                            |
| POST   | `/patients/:patientId/invoices/:invoiceId/payment-intents`            |
| POST   | `/webhooks/payments/razorpay/:merchantAccountId`                      |

### Access

| Method | Path                                                                        |
| ------ | --------------------------------------------------------------------------- |
| GET    | `/organizations/:organizationId/memberships/:membershipId/role-assignments` |
| POST   | `/organizations/:organizationId/memberships/:membershipId/role-assignments` |
| POST   | `/organizations/:organizationId/role-assignments/:assignmentId/revoke`      |

### Clinical

| Method | Path                                                                       |
| ------ | -------------------------------------------------------------------------- |
| POST   | `/organizations/:organizationId/encounters`                                |
| GET    | `/organizations/:organizationId/encounters`                                |
| GET    | `/organizations/:organizationId/encounters/:encounterId`                   |
| POST   | `/organizations/:organizationId/encounters/:encounterId/finish`            |
| POST   | `/organizations/:organizationId/visits/:visitId/close`                     |
| POST   | `/organizations/:organizationId/patients/:patientId/care-team`             |
| POST   | `/organizations/:organizationId/care-team/:assignmentId/end`               |
| POST   | `/organizations/:organizationId/encounters/:encounterId/notes`             |
| POST   | `/organizations/:organizationId/encounters/:encounterId/diagnoses`         |
| POST   | `/organizations/:organizationId/encounters/:encounterId/observations`      |
| POST   | `/organizations/:organizationId/encounters/:encounterId/prescriptions`     |
| POST   | `/organizations/:organizationId/encounters/:encounterId/referrals`         |
| POST   | `/organizations/:organizationId/clinical-notes/:noteId/draft`              |
| POST   | `/organizations/:organizationId/clinical-notes/:noteId/amend`              |
| POST   | `/organizations/:organizationId/clinical-notes/:noteId/addenda`            |
| POST   | `/organizations/:organizationId/clinical-notes/:noteId/release`            |
| GET    | `/organizations/:organizationId/prescriptions/:prescriptionId`             |
| POST   | `/organizations/:organizationId/prescription-items/:itemId/stop`           |
| POST   | `/organizations/:organizationId/clinical-records/:type/:id/sign`           |
| POST   | `/organizations/:organizationId/clinical-records/:type/:id/mark-error`     |
| GET    | `/organizations/:organizationId/clinical-records/:type/:id/revisions`      |
| POST   | `/organizations/:organizationId/patients/:patientId/allergies`             |
| POST   | `/organizations/:organizationId/allergies/:id/update`                      |
| POST   | `/organizations/:organizationId/patients/:patientId/conditions`            |
| POST   | `/organizations/:organizationId/conditions/:id/update`                     |
| POST   | `/organizations/:organizationId/patients/:patientId/medication-statements` |
| POST   | `/organizations/:organizationId/medication-statements/:id/update`          |
| POST   | `/organizations/:organizationId/patients/:patientId/immunizations`         |
| POST   | `/organizations/:organizationId/immunizations/:id/update`                  |
| GET    | `/organizations/:organizationId/patients/:patientId/clinical-summary`      |
| GET    | `/organizations/:organizationId/patients/:patientId/timeline`              |
| GET    | `/organizations/:organizationId/patients/:patientId/shared-records`        |
| POST   | `/organizations/:organizationId/tasks`                                     |
| GET    | `/organizations/:organizationId/tasks`                                     |
| POST   | `/organizations/:organizationId/tasks/:taskId/transition`                  |
| GET    | `/organizations/:organizationId/referrals/incoming`                        |
| POST   | `/organizations/:organizationId/referrals/:referralId/respond`             |
| GET    | `/patients/:patientId/clinical-records`                                    |

### Diagnostics

| Method | Path                                                                    |
| ------ | ----------------------------------------------------------------------- |
| GET    | `/diagnostic-tests`                                                     |
| POST   | `/platform/diagnostic-tests`                                            |
| POST   | `/organizations/:organizationId/encounters/:encounterId/service-orders` |
| POST   | `/organizations/:organizationId/service-orders/:orderId/transition`     |
| GET    | `/organizations/:organizationId/lab-worklist`                           |
| POST   | `/organizations/:organizationId/specimens`                              |
| POST   | `/organizations/:organizationId/specimens/:specimenId/transition`       |
| POST   | `/organizations/:organizationId/diagnostic-reports`                     |
| GET    | `/organizations/:organizationId/diagnostic-reports/:reportId`           |
| POST   | `/organizations/:organizationId/diagnostic-reports/:reportId/verify`    |
| POST   | `/organizations/:organizationId/diagnostic-reports/:reportId/amend`     |
| POST   | `/organizations/:organizationId/imaging-studies`                        |
| GET    | `/organizations/:organizationId/patients/:patientId/diagnostics`        |
| GET    | `/patients/:patientId/diagnostic-reports`                               |

### Documents

| Method | Path                                                           |
| ------ | -------------------------------------------------------------- |
| POST   | `/documents/upload-intents`                                    |
| POST   | `/documents/:documentId/complete-upload`                       |
| POST   | `/documents/:documentId/access`                                |
| POST   | `/documents/:documentId/links`                                 |
| GET    | `/me/documents`                                                |
| GET    | `/patients/:patientId/documents`                               |
| GET    | `/organizations/:organizationId/documents`                     |
| POST   | `/organizations/:organizationId/documents/:documentId/release` |

### Privacy, consent and audit

| Method | Path                                                                  |
| ------ | --------------------------------------------------------------------- |
| GET    | `/policies`                                                           |
| POST   | `/platform/policies`                                                  |
| POST   | `/me/policy-acknowledgements`                                         |
| POST   | `/patients/:patientId/consents/record-sharing`                        |
| GET    | `/patients/:patientId/consents`                                       |
| POST   | `/consents/:consentId/withdraw`                                       |
| POST   | `/organizations/:organizationId/consents`                             |
| POST   | `/organizations/:organizationId/patients/:patientId/emergency-access` |
| GET    | `/organizations/:organizationId/emergency-access`                     |
| POST   | `/organizations/:organizationId/emergency-access/:grantId/review`     |
| POST   | `/patients/:patientId/privacy-requests`                               |
| GET    | `/patients/:patientId/privacy-requests`                               |
| GET    | `/patients/:patientId/export`                                         |
| GET    | `/patients/:patientId/access-history`                                 |
| GET    | `/platform/privacy-requests`                                          |
| POST   | `/platform/privacy-requests/:requestId/decide`                        |
| POST   | `/platform/retention-holds`                                           |
| GET    | `/organizations/:organizationId/audit-events`                         |
| GET    | `/platform/audit-events`                                              |

### Inpatient and locations

| Method | Path                                                                                  |
| ------ | ------------------------------------------------------------------------------------- |
| POST   | `/organizations/:organizationId/locations`                                            |
| GET    | `/organizations/:organizationId/locations`                                            |
| POST   | `/organizations/:organizationId/locations/:locationId/state`                          |
| POST   | `/organizations/:organizationId/admissions`                                           |
| GET    | `/organizations/:organizationId/admissions`                                           |
| GET    | `/organizations/:organizationId/bed-board`                                            |
| POST   | `/organizations/:organizationId/admissions/:admissionId/admit`                        |
| POST   | `/organizations/:organizationId/admissions/:admissionId/transfer`                     |
| POST   | `/organizations/:organizationId/admissions/:admissionId/cancel`                       |
| GET    | `/organizations/:organizationId/admissions/:admissionId/nursing-chart`                |
| POST   | `/organizations/:organizationId/admissions/:admissionId/medication-administrations`   |
| POST   | `/organizations/:organizationId/medication-administrations/:administrationId/correct` |
| POST   | `/organizations/:organizationId/admissions/:admissionId/fluid-balance`                |
| POST   | `/organizations/:organizationId/admissions/:admissionId/observations`                 |
| POST   | `/organizations/:organizationId/admissions/:admissionId/discharge-plan`               |
| POST   | `/organizations/:organizationId/discharge-plans/:planId/checklist`                    |
| POST   | `/organizations/:organizationId/admissions/:admissionId/clinical-discharge`           |
| POST   | `/organizations/:organizationId/admissions/:admissionId/depart`                       |

### Pharmacy and stock

| Method | Path                                                                 |
| ------ | -------------------------------------------------------------------- |
| GET    | `/drugs`                                                             |
| POST   | `/platform/drugs`                                                    |
| POST   | `/organizations/:organizationId/inventory-items`                     |
| GET    | `/organizations/:organizationId/inventory-items`                     |
| POST   | `/organizations/:organizationId/suppliers`                           |
| GET    | `/organizations/:organizationId/suppliers`                           |
| POST   | `/organizations/:organizationId/purchase-orders`                     |
| POST   | `/organizations/:organizationId/purchase-orders/:orderId/transition` |
| POST   | `/organizations/:organizationId/purchase-orders/:orderId/receipts`   |
| POST   | `/organizations/:organizationId/stock-batches/:batchId/transition`   |
| POST   | `/organizations/:organizationId/stock-adjustments`                   |
| POST   | `/organizations/:organizationId/stock-transfers`                     |
| GET    | `/organizations/:organizationId/stock`                               |
| GET    | `/organizations/:organizationId/stock/low`                           |
| POST   | `/organizations/:organizationId/dispenses`                           |
| POST   | `/organizations/:organizationId/dispenses/:dispenseId/returns`       |

### Notifications, support, reviews, subscriptions, operations

| Method | Path                                                                      |
| ------ | ------------------------------------------------------------------------- |
| GET    | `/me/notifications`                                                       |
| POST   | `/me/notifications/:notificationId/read`                                  |
| POST   | `/support-tickets`                                                        |
| GET    | `/me/support-tickets`                                                     |
| POST   | `/support-tickets/:ticketId/replies`                                      |
| GET    | `/platform/support-tickets`                                               |
| POST   | `/platform/support-tickets/:ticketId/transition`                          |
| POST   | `/reviews`                                                                |
| GET    | `/doctors/:doctorId/reviews`                                              |
| GET    | `/platform/reviews`                                                       |
| POST   | `/platform/reviews/:reviewId/moderate`                                    |
| POST   | `/organizations/:organizationId/reviews/:reviewId/reply`                  |
| GET    | `/subscription-plans`                                                     |
| POST   | `/platform/subscription-plans`                                            |
| GET    | `/platform/subscriptions`                                                 |
| POST   | `/platform/subscriptions/:subscriptionId/payments`                        |
| GET    | `/organizations/:organizationId/subscription`                             |
| POST   | `/organizations/:organizationId/subscriptions`                            |
| POST   | `/organizations/:organizationId/subscriptions/:subscriptionId/transition` |
| GET    | `/platform/outbox/failed`                                                 |
| POST   | `/platform/outbox/:eventId/replay`                                        |
| GET    | `/platform/operations/health`                                             |

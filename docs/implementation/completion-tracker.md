# Full backend implementation tracker

On 24 November 2026 the user authorized full backend implementation and selected Razorpay for online payments. The same day an [implementation verification review](../reviews/implementation-verification-2026-11-24.md) reproduced eight defects; all eight and the walk-in access weakness are fixed and covered by regression tests ([resolution](../reviews/implementation-verification-2026-11-24.md#resolution)). This tracker separates working, tested modules from work that still depends on external setup or business decisions. It is not a production-readiness certificate.

| Workstream                                                                                                                         | Status                                                                                         | Details                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Identity, organizations, scoped memberships, profiles, provider verification                                                       | Implemented and tested                                                                         | [foundation](foundation.md), [provider marketplace](provider-marketplace.md)                           |
| Role templates; role assignment; additive role upgrade                                                                             | Implemented and tested                                                                         | [platform modules](platform-modules.md#roles-and-permissions)                                          |
| Non-doctor credential review; credential checks on signing, dispensing, verification and administration                            | Implemented and tested                                                                         | [credentials](platform-modules.md#professional-credentials-and-two-factor-sign-in)                     |
| Two-factor sign-in (TOTP, recovery codes) and privileged-user enforcement                                                          | Implemented and tested; enforcement is off until `MFA_ENFORCE_PRIVILEGED=true`                 | same                                                                                                   |
| Separate administrator portal sign-in with an emailed code on every sign-in; staff refused by the patient and doctor sign-in       | Implemented and tested                                                                         | [credentials](platform-modules.md#professional-credentials-and-two-factor-sign-in)                     |
| Services and prices, schedules, doctor leave, resource reservations, appointments, queue                                           | Implemented and tested (concurrency, expiry, transitions)                                      | [booking](platform-modules.md#services-schedules-and-booking)                                          |
| Waitlist offers                                                                                                                    | Implemented and tested                                                                         | [waitlist](platform-modules.md#waitlist)                                                               |
| Intake questionnaires; governed concern-to-specialty routing                                                                       | Implemented and tested                                                                         | [intake](platform-modules.md#intake-questionnaires-and-concern-routing)                                |
| Razorpay orders, signed raw webhook inbox, capture, refund, reconciliation, disputes, durable order recovery                       | Implemented and tested against a fake gateway; live account not exercised                      | [billing and Razorpay](platform-modules.md#billing-razorpay-and-the-ledger)                            |
| Invoicing, allocations, credit notes, offline receipts, ledger, trial balance                                                      | Implemented and tested                                                                         | same                                                                                                   |
| Insurance: payers, coverage, pre-authorization, claims, adjudication, remittance                                                   | Implemented and tested; payer decisions are entered manually (no payer integration)            | [insurance](platform-modules.md#insurance-and-claims)                                                  |
| Private documents, quarantine and scanning, scanned-bytes promotion, audited short-lived retrieval                                 | Implemented and tested with a stub store and scanner; S3 bucket and ClamAV must be provisioned | [documents](platform-modules.md#private-documents)                                                     |
| Consent, sharing grants, emergency access, privacy requests, export, audit views                                                   | Implemented and tested                                                                         | [privacy](platform-modules.md#privacy-and-audit)                                                       |
| Medical representative authority separate from demographic authority; identity merge                                               | Implemented and tested                                                                         | [identity merge](platform-modules.md#patient-identity-merge)                                           |
| Care teams, encounters with arrival evidence, branch-scoped charts, signed records, prescriptions, tasks                           | Implemented and tested                                                                         | [clinical](platform-modules.md#clinical-records)                                                       |
| Secure patient–provider messaging                                                                                                  | Implemented and tested                                                                         | [messaging](platform-modules.md#secure-messaging)                                                      |
| Diagnostic orders, specimens, results, verification, critical-result acknowledgement, imaging references                           | Implemented and tested; LIS/PACS exchange is an adapter boundary                               | [diagnostics](platform-modules.md#diagnostics)                                                         |
| Pharmacy, branch-scoped stock, dispensing, returns, movements, procurement                                                         | Implemented and tested                                                                         | [pharmacy](platform-modules.md#pharmacy-stock-and-procurement)                                         |
| Admissions, beds and transfers, medication administration, fluid balance, discharge                                                | Implemented and tested                                                                         | [inpatient](platform-modules.md#inpatient-care)                                                        |
| Theatre and procedure cases with the surgical safety checklist                                                                     | Implemented and tested                                                                         | [theatre](platform-modules.md#theatre-and-procedures)                                                  |
| Outbox relay and consumers, notifications, support, reviews, provider subscriptions                                                | Implemented and tested                                                                         | [operations](platform-modules.md#notifications-events-and-workers)                                     |
| OpenAPI contract, readiness probe, setup and upgrade, worker process and container                                                 | Implemented: generated OpenAPI 3.1, `/health/ready`, `db:setup`, worker service in Compose     | [run and verify](platform-modules.md#run-and-verify), [API contract](platform-modules.md#api-contract) |
| Frontend integration: guide, generated field-level API reference, request schemas in OpenAPI, `/me/workspaces` navigation endpoint | Implemented and tested                                                                         | [frontend guide](../frontend/README.md), [API reference](../frontend/api-reference.md)                 |

Verification: typecheck, lint, Prettier and build pass; 21 unit tests and 59 integration tests across 10 replica-set suites pass.

## Still required before production

- **External setup:**
  - Provision the private document bucket and a network-restricted ClamAV.
  - Configure Razorpay merchant secrets as `env:RAZORPAY_*` references.
  - Register the webhook URL and complete a sandbox and then live reconciliation.
  - Set `MFA_ENCRYPTION_KEY` and turn on `MFA_ENFORCE_PRIVILEGED` once administrators have enrolled.
  - Run `npm run db:setup` deliberately against the target database. It was not run against the configured application database during implementation.
- **Business decisions** from the [decision register](../architecture/09-coverage-and-decisions.md):
  - Platform collection and commission settlement (D03/D04).
  - Final cancellation windows (D06).
  - Specialty and telemedicine prescribing scope (D07).
  - Retention periods (D09).
  - Who may author concern-routing rules clinically, and the initial rule set.
- **Not yet implemented:**
  - Marketplace commission accrual and provider settlement statements (waits on D03/D04).
  - Nursing assessment scales, care plans, safety incidents, formulary policy and stock reservations.
  - SMS, push and video-consultation provider integrations.
  - ABDM/FHIR, payer/TPA and other partner integrations.
  - The specialist hospital modules listed in the hospital dictionary.
- **Operations and acceptance:**
  - Append-only database roles.
  - Backup and restore drills.
  - Monitoring and alert owners.
  - Load tests and a full concurrency campaign.
  - Clinical, privacy and legal acceptance.

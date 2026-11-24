# Full backend implementation tracker

On 24 November 2026 the user authorized full backend implementation and selected Razorpay for online payments. This tracker separates working, tested modules from work that still depends on external setup or business decisions. It is not a production-readiness certificate.

| Workstream                                                                                               | Status                                                                                                         | Details                                                                      |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Identity, organizations, scoped memberships, profiles, provider verification                             | Implemented and tested                                                                                         | [foundation](foundation.md), [provider marketplace](provider-marketplace.md) |
| Role templates for nurse, laboratory and pharmacist; role assignment; additive role upgrade              | Implemented and tested                                                                                         | [platform modules](platform-modules.md#roles-and-permissions)                |
| Services and prices, schedules, doctor leave, resource reservations, appointments, queue                 | Implemented and tested (concurrency, expiry, transitions)                                                      | [booking](platform-modules.md#services-schedules-and-booking)                |
| Razorpay orders, signed raw webhook inbox, capture, refund, reconciliation, disputes                     | Implemented and tested against a fake gateway; live account not exercised                                      | [billing and Razorpay](platform-modules.md#billing-razorpay-and-the-ledger)  |
| Invoicing, allocations, credit notes, offline receipts, ledger, trial balance                            | Implemented and tested                                                                                         | same                                                                         |
| Private documents, quarantine and scanning, audited short-lived retrieval                                | Implemented and tested with a stub store and scanner; S3 bucket and ClamAV must be provisioned                 | [documents](platform-modules.md#private-documents)                           |
| Consent, sharing grants, emergency access, privacy requests, export, audit views                         | Implemented and tested                                                                                         | [privacy](platform-modules.md#privacy-and-audit)                             |
| Care teams, encounters, signed notes and observations, diagnoses, prescriptions, tasks, referrals        | Implemented and tested                                                                                         | [clinical](platform-modules.md#clinical-records)                             |
| Diagnostic orders, specimens, results, verification, critical-result acknowledgement, imaging references | Implemented and tested; LIS/PACS exchange is an adapter boundary                                               | [diagnostics](platform-modules.md#diagnostics)                               |
| Pharmacy, stock batches, dispensing, returns, movements, procurement                                     | Implemented and tested                                                                                         | [pharmacy](platform-modules.md#pharmacy-stock-and-procurement)               |
| Admissions, beds and transfers, medication administration, fluid balance, discharge                      | Implemented and tested                                                                                         | [inpatient](platform-modules.md#inpatient-care)                              |
| Outbox relay and consumers, notifications, support, reviews, provider subscriptions                      | Implemented and tested                                                                                         | [operations](platform-modules.md#notifications-events-and-workers)           |
| API catalog, setup and upgrade, worker process, end-to-end verification                                  | Implemented: route catalog, `db:setup`, `npm run worker`, and 33 replica-set integration tests plus unit tests | [run and verify](platform-modules.md#run-and-verify)                         |

## Still required before production

- **External setup:**
  - Provision the private document bucket and a network-restricted ClamAV.
  - Configure Razorpay merchant secrets as `env:RAZORPAY_*` references.
  - Register the webhook URL and complete a sandbox and then live reconciliation.
  - Run `npm run db:setup` deliberately against the target database. It was not run against the configured application database during implementation.
- **Business decisions** from the [decision register](../architecture/09-coverage-and-decisions.md):
  - Platform collection and commission settlement (D03/D04).
  - Final cancellation windows (D06).
  - Specialty and telemedicine prescribing scope (D07).
  - Retention periods (D09).
- **Not yet implemented:**
  - Waitlist offers.
  - Theatre and procedure cases.
  - Insurance and claims.
  - Nursing assessment scales.
  - Credential review for non-doctor professionals.
  - MFA for privileged staff.
  - ABDM/FHIR and partner integrations.
  - The specialist hospital modules listed in the hospital dictionary.
- **Operations and acceptance:**
  - Append-only database roles.
  - Backup and restore drills.
  - Monitoring and alert owners.
  - Load tests.
  - Clinical, privacy and legal acceptance.

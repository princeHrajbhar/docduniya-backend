# Requirement coverage and decisions before implementation

## Confirmed product direction

The user confirmed a marketplace similar in operating concept to a service-provider platform: multiple hospitals and clinics register, independent doctors register, patients and doctors connect, and DocDuniya supplies the management software ecosystem. India is the primary market. The requested technology is Node.js, Express, MongoDB and Mongoose. Implementation has not been authorized in this task.

The outpatient-first sequence is a recommendation; the full common hospital scope remains mapped. Exact launch modules, payment arrangements and operational policies remain product decisions.

## Traceability to the request

| Requested or supplied concept                     | Final design location / interpretation                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Patient/doctor/admin login                        | Users, auth identities, sessions, scoped role assignments; portals are views of permissions                                               |
| Complete personal profile                         | Patient/practitioner profiles, private addresses/contacts, DOB precision, language, emergency contacts and patient registration snapshots |
| Academic/professional information                 | Practitioner qualifications, dated employment, professional registrations, verification evidence                                          |
| Working hospital and personal clinic              | Organizations, facilities, doctor affiliations, service offerings; solo practice organization                                             |
| Residential and practice addresses                | Private personal profile addresses separated from public facility addresses                                                               |
| Users to patients/doctors                         | Optional claimed patient and practitioner links; doctor is a professional specialization; account can have both roles                     |
| User roles and sessions                           | Separate roles/assignments/memberships and userSessions, not a single global role                                                         |
| Patient addresses and contacts                    | Bounded values rather than unnecessary one-to-one collections                                                                             |
| Allergies, medications and history                | Independent clinical collections with source/review states and tenant custody                                                             |
| Doctor qualifications, specialties, registrations | Qualifications/registrations separate; specialties bounded references; affiliation privileges independent                                 |
| Symptoms, diseases and specialty mapping          | Versioned clinicalConcepts and reviewed concernMappings; symptom association is not diagnosis                                             |
| Doctor discovery                                  | Public search projections, verified eligibility, location, mode, language, price, availability and review rules                           |
| Doctor schedules, slots and appointments          | Recurrence/exception records, derived slots, resource calendars and transactional interval claims                                         |
| Slot to booking                                   | One active capacity-one resource claim; many historical cancelled/expired slot references allowed                                         |
| Booking state diagram                             | Explicit hold, expiry, confirmation, check-in, in-progress, completed/discontinued/cancelled/no-show transitions                          |
| Appointment to encounter                          | Optional appointment linkage; zero/many encounters, with visit grouping and walk-ins                                                      |
| Notes, diagnosis, observations and procedures     | Separate resources, clinical provenance, signed revisions and correction workflow                                                         |
| Prescriptions and prescription items              | Stable item IDs for dispense/admin; immutable signed aggregate snapshot                                                                   |
| Secure document upload                            | Pending intent, quarantine, authoritative object verification, malware scan, immutable version and audited access                         |
| Consent and patient access grants                 | Purpose/recipient/resource/time scope plus authority, legal basis, withdrawal and audit                                                   |
| Invoice and payments                              | Many-to-many allocations, independent capture/refund, invoice credits, ledger and reconciliation                                          |
| User audit logs                                   | Append-only auditEvents with user or service actor; reads, denials and exports included                                                   |
| Hospital platform scope                           | Admission, bed transfer, nursing, medication administration, orders/results, pharmacy/stock, discharge and claims                         |
| Marketplace operation                             | Provider verification, subscriptions, contracts, commission accrual, settlements, disputes, reviews and support                           |
| HLD/LLD and software principles                   | Modules, ownership, trust boundaries, explicit dependencies, state commands, unit of work, outbox, adapters and projections               |
| Roadmap and operational readiness                 | Phased vertical delivery, test gates, migration, observability, incident response and recovery                                            |

## Business decisions and recommended defaults

These defaults make the design concrete for review; they are not an instruction to implement unapproved commercial or clinical policies.

| ID  | Decision                          | Recommended starting point                                                                                                                | Changes if chosen differently                                                                                                      |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| D01 | Launch modules                    | Marketplace plus complete outpatient provider workflow, then hospital modules                                                             | A hospital-first contract adds admission/nursing/diagnostics/pharmacy/downtime gates before first launch                           |
| D02 | Provider tenant boundary          | One contracted legal provider organization, branches beneath it; solo doctor is a solo practice                                           | Separate legal subsidiaries remain distinct tenants unless contracts authorize shared custody                                      |
| D03 | Payment collection responsibility | Begin with a clearly contracted provider merchant model; use approved gateway marketplace collection only after provider/legal acceptance | Platform collection requires beneficiary allocation, liabilities, settlement reserves, chargeback handling and accounting sign-off |
| D04 | Revenue                           | Versioned provider SaaS plans; any booking fee/commission explicitly contracted and disclosed                                             | Percentage/flat fees, patient convenience fee, taxes, refunds and settlement attribution need approved examples                    |
| D05 | Booking policies                  | Capacity one, explicit hold expiry, no automatic revival after expiry, pay-at-provider allowed by offering                                | Deposits, grace period, group bookings, overbooking and travel policies change state/claim/pricing rules                           |
| D06 | Cancellation/reschedule           | Snapshot policy at booking; cancellation and refund proceed as independent tracked operations                                             | Exact notice windows, provider cancellations, no-show fee and price differences need business decisions                            |
| D07 | Medical scope                     | Verified licensed practitioners, clinician-authored care, reviewed concern-to-specialty routing                                           | Telemedicine specialty rules and prescribing scope need current clinical/legal approval                                            |
| D08 | Record sharing                    | Explicit custody, patient-mediated cross-provider sharing and lawful care access within provider policy                                   | Automatic network-wide chart access is not the default and would require a new governance design                                   |
| D09 | Retention and deletion            | Class-based policy, legal holds, reviewed erasure/export; no automatic clinical TTL                                                       | Exact years, minor records, jurisdiction/state and specialty requirements need legal/custodian decision                            |
| D10 | ABDM and insurance                | Integration boundary now; activate when launch contracts require it                                                                       | Certification/partner versions and payer data sets add acceptance gates                                                            |
| D11 | Messaging/video                   | Provider-managed appointment channel; external video provider; no recording by default                                                    | Recording, asynchronous clinical advice and emergency response require separate consent/retention/workflow policy                  |
| D12 | Scale and service targets         | Use the pilot assumptions and measured load tests in the operations document                                                              | Actual provider counts, geography, inpatient reliance and budgets drive topology/SLO changes                                       |
| D13 | Platform support access           | Masked operational context, ticket-specific escalation and audited privileged access                                                      | Broad impersonation/chart access would expand risk and needs explicit product/legal review                                         |
| D14 | Specialty hospital functions      | Common hospital foundation; contracted specialty modules designed separately                                                              | Blood bank/ICU/device/specialty care requires expert-specific models beyond generic metadata                                       |

## Design review gate

Before writing schemas, resolve D01-D09 to the degree required by the launch scope and nominate owners for clinical governance, finance and privacy. Confirm domain vocabulary and example workflows with an actual doctor, receptionist and provider administrator; include nursing/lab/pharmacy roles when those modules launch.

Before production, each release must demonstrate reference/tenant integrity, repeatable index migrations, safe concurrent booking, preserved signed records, reconciled money, secure files, actionable audit, and successful restore. Adding a collection or passing a unit test alone does not meet these workflow gates.

The design covers the declared common marketplace/provider/hospital ecosystem. It deliberately identifies specialist and jurisdiction-specific work instead of claiming that any finite schema list covers every future hospital requirement.

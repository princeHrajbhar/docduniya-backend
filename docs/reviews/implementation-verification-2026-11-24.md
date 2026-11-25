# Backend implementation verification — 24 November 2026

**Verdict: the implementation substantially follows the modular architecture, but it does not yet satisfy the complete design or its release gates.** The existing test suite passes. Additional review scenarios reproduced eight implementation defects and one care-access policy weakness. Clinical data access, document integrity, pharmacy/nursing integration and payment recovery need corrections before this backend can be accepted for production use.

Reviewed checkout: `b977b27` (`version all api route done`), including the working-tree changes already present in `package.json` and `docs/implementation/foundation.md`. Baseline: the ten documents under `docs/architecture`, particularly workflows/invariants, core and hospital dictionaries, security and the decision register. The historical design document's statement that implementation was not yet authorized is not a current restriction; the user subsequently authorized implementation.

No implementation files were changed during this review. This report and ignored review scripts/logs under `.cache` were added. Tests used randomly named temporary local databases, synthetic identities, a fake payment gateway and in-memory document storage. No application database migration, real payment, cloud upload or notification was performed.

## Checks performed

| Check                                                            | Result                                             |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `npm run typecheck`                                              | Passed                                             |
| `npm run lint`                                                   | Passed                                             |
| `npm run build`                                                  | Passed                                             |
| `npm test`                                                       | 16 passed across 3 files                           |
| `npm run test:integration`                                       | 33 passed across 6 files                           |
| Additional isolated review scenarios                             | 9 completed; adverse results below were reproduced |
| Live Razorpay, S3, ClamAV, deployment/load/recovery verification | Not exercised                                      |

Integration tests used MongoDB 8.2.6 in a local replica set. Passing these tests does not validate a different deployed database version or prove all business invariants. The existing booking race test uses 12 competing holds; it is not the architecture's full load/concurrency acceptance campaign.

Review reproductions: [.cache/review-probes.ts](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/.cache/review-probes.ts), with [observed results](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/.cache/review-probes-output.txt). These are diagnostic probes, not additions to the maintained regression suite. Unit and integration outputs are in `.cache/review-unit.txt` and `.cache/review-integration.txt`.

## Defects requiring correction

P1 means a high-priority access, integrity or operational defect to fix before release. P2 means a recovery defect requiring correction and a regression test.

### R1 — P1: File promotion is not bound to the scanned object version

[document.service.ts:252](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/documents/document.service.ts:252), [document.service.ts:279](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/documents/document.service.ts:279), [private-storage.ts:78](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/documents/private-storage.ts:78).

The worker reads and scans a quarantine key, then separately copies the latest object at that key. The read/copy interface does not bind either operation to the source object version. An uploader can reuse the still-valid upload URL to replace the object between these operations. The clean hash then describes different bytes from the available file.

**Reproduced:** replacing the in-memory source while the scanner returned its clean verdict produced an `AVAILABLE` document containing unscanned replacement bytes. The available bytes' hash differed from the stored scan hash.

Bind upload completion, read and copy to an immutable source version, or promote the actual scanned bytes to a new immutable object. Persist and verify the exact version/checksum. Add a replacement-during-scan regression test; merely enabling bucket versioning without selecting the source version is insufficient.

### R2 — P1: Demographic permissions grant medical access and sharing authority

[clinical-query.service.ts:228](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/clinical-query.service.ts:228), [privacy.service.ts:173](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/privacy/privacy.service.ts:173), [patient.service.ts:28](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/patients/patient.service.ts:28).

`patientRecords` uses `profile.read`, and `grantRecordSharing` uses `profile.update`. The relationship model defines these alongside `registration.create`; it has no separate medical-read or consent-management action. Document access, reports and exports also reuse profile authority. This broadens previously granted demographic authority into access to health information across providers.

**Reproduced:** a representative with only `profile.read` and `profile.update` read clinical visit history and created a medical-record sharing consent.

Introduce distinct, reviewed representative authority for medical reads, exports and consent management. Evaluate it on every corresponding command/read. Existing demographic grants must not be silently upgraded.

### R3 — P1: Chart summaries bypass facility restrictions

[clinical-query.service.ts:87](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/clinical-query.service.ts:87), [encounter.service.ts:357](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/encounter.service.ts:357), [clinical.policy.ts:34](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/clinical.policy.ts:34).

Summary, timeline and several record queries authorize without a facility, then read by organization and patient only. Care assignments are also organization/patient scoped. Consequently, a member restricted to one branch can obtain another branch's content through aggregate endpoints even when its individual endpoint rejects access.

**Reproduced:** branch A's clinician received a branch B encounter, including its chief complaint, through `clinicalSummary`; `getEncounter` correctly denied that same encounter.

Apply consistent facility/custody policy to individual and aggregate reads. Where patient-level longitudinal information is deliberately shared across branches, make that authority explicit instead of bypassing membership scope incidentally.

### R4 — P1: Shared documents ignore the granted date range and clinical role requirement

[document.service.ts:398](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/documents/document.service.ts:398), [access.constants.ts:57](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/access/access.constants.ts:57).

The cross-provider fallback accepts an active organization grant plus `documents.read`. It does not enforce `recordPeriodStart`/`recordPeriodEnd`, and it does not require a practitioner or care relationship. Administrative roles include `documents.read`, so this fallback provides clinical documents to administrative members.

**Reproduced:** a recipient organization's owner with no practitioner profile received a download URL for a clinical document outside the sharing consent's date range.

Enforce the granted record period and purpose, and require the intended clinical recipient authority. Add separate tests for an out-of-period document and an administrative recipient.

### R5 — P1: Dispensing can deduct stock from an unauthorized branch

[pharmacy.service.ts:812](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/pharmacy/pharmacy.service.ts:812), [pharmacy.service.ts:937](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/pharmacy/pharmacy.service.ts:937).

The command checks the submitted `pharmacyFacilityId`, but passes each submitted `line.locationId` directly into stock movement. It does not resolve that location and verify its facility against the pharmacy and the member's scope.

**Reproduced:** a pharmacist authorized only at branch A submitted A as the pharmacy and branch B's store as the line location. Dispensing succeeded and B's stock fell from one to zero.

Resolve and authorize every stock location inside the transaction; require an appropriate active location belonging to the authorized facility. Review return/transfer/adjustment paths for the same invariant.

### R6 — P1: Full dispensing prevents medication administration

[pharmacy.service.ts:899](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/pharmacy/pharmacy.service.ts:899), [inpatient.service.ts:460](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/inpatient/inpatient.service.ts:460).

Dispensing the full authorized quantity marks a prescription item `COMPLETED`. Medication administration only accepts items whose status is `ACTIVE`. Supply completion therefore ends clinical administration eligibility, although dispensing and giving a dose are separate lifecycle facts in the design.

**Reproduced:** after a full dispense, recording a dose for an admitted patient failed with “An active prescription item for this patient is required.” The nurse had valid branch and care-team authority.

Separate fulfillment status/remaining quantity from the medication order's clinical status. Keep administration possible for a current clinical order after supply is complete; independently enforce stop, cancellation and clinical validity rules.

### R7 — P1: Suspended doctors can sign new clinical notes

[record.service.ts:589](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/record.service.ts:589), [record.service.ts:612](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/record.service.ts:612).

Signing checks current professional eligibility only in the prescription branch. Clinical notes and diagnoses check role, practitioner identity, authorship and care assignment, but not the doctor's current verification/affiliation privileges.

**Reproduced:** after a platform reviewer suspended the doctor's verification, that doctor created and signed a new consultation note successfully.

Use profession- and action-specific current credential/affiliation checks for clinical signing. Handle historical corrections under an explicit exception policy rather than allowing unrestricted new signatures after suspension.

### R8 — P2: A committed payment intent can become permanently unprocessed

[payment.service.ts:85](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/payments/payment.service.ts:85), [payment.service.ts:725](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/payments/payment.service.ts:725).

The HTTP path commits a `CREATED` intent and then calls `prepareOrder`. The recovery worker selects only `ORDER_PENDING`. If the process stops after commit but before preparation or its final database update, the intent remains `CREATED`; no registered outbox consumer prepares it. Recovery depends on the client repeating the request. Order preparation also has no persisted lease before external I/O.

**Reproduced:** the pending-order worker picked up zero records and left a committed `CREATED` intent unchanged.

Make initial and retry preparation durable worker work, with a lease/attempt identity persisted before external I/O. Reconcile unknown outcomes before creation. Test crashes before the gateway call and after remote success but before local persistence, plus concurrent workers.

## Additional care-access policy weakness

[encounter.service.ts:75](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/encounter.service.ts:75) accepts `requireCare: false` for a new encounter and then creates the caller's care assignment. No appointment, checked-in visit, referral or independently assigned treatment relationship is required for a walk-in. Admission requests have a similar entry point.

**Reproduced:** an unrelated nurse could not read a chart, created a walk-in encounter for that patient, and could then read it. This is intentional behavior in the implementation documentation, so it needs an explicit product/clinical policy decision, not an assumption that the care-team gate already prevents self-authorized access. If unrelated clinicians must be excluded, require independently established arrival/assignment or the audited emergency path.

## Design coverage

The registry contains 99 healthcare-domain collections, in addition to existing authentication/content models. This is an inventory, not a completion percentage: the design deliberately allows bounded embedding, derived slots, renamed models and staged extensions.

| Design area                                        | Implementation assessment                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node/Express/TypeScript/Mongoose modular monolith  | Matches the chosen stack and module structure. Command services, strict DTOs, optimistic versions, transactions, audit/outbox and external adapters are present.                                                                                                                                                 |
| Multiple hospitals, clinics and solo practices     | Organization/facility boundaries, scoped memberships and doctor affiliations are present. Cross-facility enforcement is inconsistent in newer modules (R3/R5).                                                                                                                                                   |
| Personal/professional profiles and provider review | Existing profile, qualification, employment, registration and independent doctor/provider review flows are present. Non-doctor credential verification remains absent.                                                                                                                                           |
| Discovery                                          | Verified public listings, offerings and ratings exist. Versioned questionnaires/intakes and governed symptom/concern-to-specialty routing are absent. Geographic/advanced ranking is not the full proposed discovery workflow.                                                                                   |
| Patient identity and registration                  | Patient identities, dependents and provider MRNs are present. Reviewed identity merge/alias reconciliation is absent. Medical representative authorization needs R2.                                                                                                                                             |
| Booking                                            | Services, prices, schedules, interval claims, holds, expiry, cancellation, rescheduling and queue are present. Waitlist offers are absent. Credential suspension/expiry has no implemented reassignment consumer/sweep equivalent to the doctor-leave worklist.                                                  |
| Clinical                                           | Visits, encounters, facts, notes, diagnoses, revisions, prescriptions, referrals and tasks are present. Access/signing defects remain. Dedicated medical-history entries, procedures and care plans are absent.                                                                                                  |
| Finance                                            | Direct-provider Razorpay adapter, raw signed inbox, capture/refund, invoices/credits, allocations, ledger and reconciliation are present. Crash recovery needs R8. Provider contracts, commission accrual and settlement workflows are absent; platform collection remains an explicit business decision.        |
| Privacy/documents                                  | Policies, consent/grants, emergency access, privacy requests, audit and a private upload pipeline exist. R1/R2/R4 prevent accepting their claimed guarantees. The export is a bounded JSON snapshot, not a complete paginated/asynchronous export with a full artifact manifest.                                 |
| Diagnostics                                        | Orders, specimens, reports, amendments, critical tasks and imaging references are present. Real LIS/PACS exchange and a dedicated laboratory execution/work-item workflow are absent. Non-doctor signing credentials require governance and implementation.                                                      |
| Pharmacy/procurement                               | Batches, balances/movements, procurement, dispensing and returns are present. R5/R6 break important integrated workflows. Formulary policy and stock reservations are absent.                                                                                                                                    |
| Inpatient                                          | Admissions, bed occupancy/transfers, fluid balance, MAR and discharge are present. Nursing assessment scales, theatre/procedure cases, payer/insurance/preauthorization/claims/remittances and safety incidents are absent.                                                                                      |
| Subscriptions                                      | Plans, current subscription, manual finance payment recording and renewal states exist. Entitlements are returned by a query, but no commercial command enforcement/usage metering was found. This is not full SaaS billing and quota enforcement.                                                               |
| Communication/support                              | In-app/email notifications, support and moderated reviews exist. SMS/push, conversations/messages and live video-provider integration are not implemented. These can be deferred where launch scope permits.                                                                                                     |
| Runtime/operations                                 | Separate worker and additive database setup exist. Workers poll MongoDB rather than implementing the proposed Redis/BullMQ deployment. Readiness/index verification, deployment automation, load/restore drills and full monitoring acceptance remain outstanding. Docker Compose currently starts the API only. |
| API/security delivery                              | Mounted routes and a Markdown route catalog exist. No machine-readable OpenAPI contract or privileged-user MFA implementation was found. A schema enum containing `MFA` is not an MFA flow.                                                                                                                      |

Several missing areas were explicitly allowed as later phases in the design. Their absence does not mean the core modular architecture is wrong, but it prevents describing the whole planned ecosystem as fully implemented. The completion tracker already acknowledges some of these omissions; its broad “implemented and tested” rows must not be read as proof of the failed invariants above.

## Integration and acceptance limits

The adapter's receipt lookup and refund header match Razorpay's published interfaces: [order receipt filtering](https://github.com/razorpay/markdown-docs/blob/master/api/orders/fetch-all.md) and [refund idempotency](https://github.com/razorpay/markdown-docs/blob/master/api/refunds/normal-refunds-idempotent.md). That contract check does not replace merchant sandbox testing, webhook retry/order tests, reconciliation or live onboarding. The fake gateway does not reproduce process failure or all provider behaviors.

S3 versioning/immutability, ClamAV availability, database privileges, production secret provisioning, backup restore and deployment topology were not verified. Clinical/governance decisions and the design's pending business choices remain acceptance work. No legal compliance or production-readiness certification is implied by this review.

## Recommended completion gate

1. Correct R1–R8 and convert the reproductions into maintained regression tests. Resolve the walk-in/self-assignment access policy explicitly.
2. Test combined journeys: cross-branch clinical access; consent revocation/periods; scanned-object replacement; prescription to dispense to administration; credential suspension; crash/restart around gateway calls. Include multiple worker instances and stale leases.
3. Reconcile the launch scope with the coverage table. Mark deferred features explicitly instead of claiming full ecosystem completion.
4. Exercise the real configured adapters in sandbox/staging, check required indexes and deployment readiness, then complete load, restore, clinical and operational acceptance before production.

## Resolution

Fixed on 24 November 2026. Each defect has a regression test in [verification-regressions.test.ts](../../tests/integration/verification-regressions.test.ts) that reproduces the attack, expects it to fail, and proves the legitimate path still works. The diagnostic probes in `.cache` describe the pre-fix behaviour and are superseded by that suite.

| Finding                            | Fix                                                                                                                                                                                                                                                                                                              | Regression test                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| R1 scanned bytes vs promoted       | The scanner writes the exact bytes it scanned to a new immutable key (create-only `PutObject`); the mutable upload key is never copied. The stored hash describes the available object.                                                                                                                          | R1: replacement during scan                                 |
| R2 demographic → medical access    | New representative actions `medical.read`, `medical.upload`, `medical.export`, `consent.manage`, granted only by an independent reviewer with evidence and an expiry. Records, reports, documents, export, consents, privacy requests and access history use them. Existing demographic grants are not upgraded. | R2: profile-only representative                             |
| R3 aggregate reads across branches | Every clinical record stores its facility. Individual and aggregate reads (summary, timeline, encounter and diagnostics lists, revisions) apply the same facility rule; care relationships are honoured only under the member's current membership.                                                              | R3: branch-restricted clinician                             |
| R4 shared documents                | The grant's record period and purposes are enforced, and only the recipient's treating clinicians (clinical permission, registration, care relationship) receive shared documents. Refusals are `404`.                                                                                                           | R4: out-of-period, administrator and wrong-purpose requests |
| R5 cross-branch stock              | Every stock location is resolved and authorized at its facility inside the transaction (dispense lines, adjustments, transfers, purchase-order destinations, batch release, balance views); dispense lines must use the dispensing pharmacy's locations.                                                         | R5: branch B store                                          |
| R6 dispensing ends administration  | Supply is tracked in `fulfillmentStatus`; the clinical item stays `ACTIVE` until stopped or the prescription lapses.                                                                                                                                                                                             | R6: full dispense, then a dose                              |
| R7 suspended doctor signs          | All `clinical.sign` actions require a current credential (doctor verification and affiliation, or an approved professional credential). Suspension also flags the doctor's upcoming appointments for reassignment.                                                                                               | R7: suspension blocks signing                               |
| R8 stranded payment intents        | Order preparation takes a persisted lease before network I/O, always looks up the order by receipt, checks amount and currency, and the worker picks up `CREATED` and stale-lease intents.                                                                                                                       | R8: crash before preparation, stale lease, two workers      |
| Walk-in self-assignment            | Policy decided: starting an encounter or requesting an admission needs arrival evidence (checked-in appointment, today's front-desk queue entry, open visit), an existing care relationship or reviewed emergency access; otherwise `409 ARRIVAL_REQUIRED`.                                                      | walk-in test                                                |

The coverage gaps listed above were also addressed where the design allowed: non-doctor credential review, privileged-user MFA, intake questionnaires, governed concern routing, identity merge, waitlist offers, insurance and claims, theatre cases, secure messaging, a generated OpenAPI contract, a readiness probe and a worker container. Commission settlement (D03/D04), nursing scales, care plans, safety incidents, formulary, stock reservations, SMS/push/video and partner integrations remain open; see the [completion tracker](../implementation/completion-tracker.md).

# Backend verification — 25 November 2026

**Verdict: not all correct yet.** The current automated suite passes, including the new tests for the previous review. Ten additional isolated scenarios reproduced nine actionable findings below. The previous report's blanket statement that the access weakness and all related guarantees are resolved is too strong.

Reviewed `b977b27` plus the current modified and untracked backend files, including the new MFA, credentials, intake, waitlist, messaging, merge, insurance and procedure modules. This is a backend review, not a frontend or deployed-environment acceptance test.

No application source was changed during this recheck. This report and ignored diagnostic scripts/logs were added. All database scenarios used synthetic accounts and randomly named temporary local replica-set databases, removed afterward. Document storage and scanning were fake. The application database, real Razorpay account, S3 and notification delivery were not exercised.

## Checks

| Check                         | Result                      |
| ----------------------------- | --------------------------- |
| `npm run typecheck`           | Passed                      |
| `npm run lint`                | Passed                      |
| `npm run format:check`        | Passed                      |
| `npm run build`               | Passed                      |
| `npm test`                    | 19 passed, 4 files          |
| `npm run test:integration`    | 52 passed, 9 files          |
| Additional targeted scenarios | 10 completed; results below |

The first sandboxed test attempt could not connect to local HTTP/MongoDB ports (`EACCES`). The successful runs above used permitted local networking. This was an execution restriction, not an application test failure.

Evidence: [main probes](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/.cache/recheck-probes.ts), [main results](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/.cache/recheck-probes-output.txt), [clinical probes](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/.cache/recheck-clinical-probes.ts), [clinical results](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/.cache/recheck-clinical-probes-output.txt). These diagnostic scripts deliberately observe adverse behavior; they are not maintained regression tests asserting the intended behavior.

## Findings

### F1 — P1: A clinician can manufacture the arrival evidence used to grant chart access

[encounter.service.ts:271](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/encounter.service.ts:271), [queue.service.ts:65](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/appointments/queue.service.ts:65), [access.constants.ts:114](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/access/access.constants.ts:114).

The new arrival gate trusts any current queue entry for the patient. Both clinician and nurse roles have `queue.manage`, and `addWalkIn` uses that permission without requiring an existing treatment relationship or an independent arrival attestation. An unrelated clinician can therefore create the queue entry, submit its ID to `startEncounter`, and acquire a care assignment.

**Reproduced:** an unrelated nurse initially received `404` for the chart, created their own walk-in entry, opened an encounter and then read the chart. The maintained walk-in regression only tries opening an encounter without arrival evidence; it does not try creating that evidence first.

Use an explicitly authorized arrival/dispatch workflow whose evidence cannot be self-issued by the clinician seeking access. Validate evidence provenance, recipient and current validity inside the transaction. Test the complete queue-create → encounter → chart sequence as well as legitimate reception, patient-booked and emergency paths.

### F2 — P1: Document downloads still bypass branch restrictions

[document.service.ts:402](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/documents/document.service.ts:402), [document.model.ts:47](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/documents/document.model.ts:47).

Same-provider document access calls `authorizeClinical` without a facility or record custody. The document does not store its facility, and its encounter links are not used to authorize the download. The revised encounter, summary and timeline filters consequently do not protect their attachments.

**Reproduced:** branch B's clinician uploaded and linked a clinical report to a branch B encounter. Branch A's clinician received `404` for that encounter but successfully obtained a download URL for its document.

Persist or resolve authoritative facility custody for provider documents and enforce it consistently for upload/linking, lists, release and downloads. Do not let administrative document permissions or an organization-wide query substitute for clinical custody.

### F3 — P1: The clinical task list exposes unrelated patients' information

[task.service.ts:207](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/task.service.ts:207).

`listTasks` checks organization permission and practitioner identity, then accepts `mine=false` to remove the assignee restriction. It applies neither the patient's care relationship nor a facility filter. The response contains patient IDs, clinical task titles and source-record references.

**Reproduced:** a nurse who received `404` for a patient's chart could list a private follow-up task assigned to another clinician, including its confidential title.

Authorize the worklist through explicit team/dispatch scope and restrict the query to currently accessible patients and facilities. Apply the same policy to task details and transitions. A client-controlled query parameter must not widen medical authority.

### F4 — P1: Enabling privileged MFA does not protect existing role administration

[auth.middleware.ts:97](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/admin/auth/auth.middleware.ts:97), [role.routes.ts:18](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/admin/auth/roles/role.routes.ts:18).

MFA enrollment enforcement was added to `requirePlatformPermission` and selected organization permissions. Existing platform routes still use `requirePermission`/`requireAnyPermission`, which do not enforce it. This leaves sensitive role administration reachable without enrollment even when the enforcement setting is on.

**Reproduced:** with privileged enforcement enabled, an unenrolled administrator was rejected by the professional-review service with `403`, but the same user's authenticated `POST /api/v1/roles` returned `201` and created a role.

Apply one consistent MFA/session-assurance policy across every privileged route, including existing user and role administration. Test actual HTTP mutation routes, not only a newly added service's enrollment check.

### F5 — P1: Insurance claims cross facility authorization boundaries

[insurance.service.ts:349](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/insurance/insurance.service.ts:349), [insurance.service.ts:601](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/insurance/insurance.service.ts:601).

Claim submission collects the invoices' facilities but authorizes only the first one. It does not reject or authorize the remaining facilities. `listClaims` also queries the whole organization without applying membership facility restrictions.

**Reproduced in two scenarios:** a biller restricted to one branch submitted a claim containing an invoice from the other branch; the same restricted biller listed a separate claim belonging entirely to the other branch. MongoDB's unsorted invoice result order determines which facility the submission checks, so the probe explicitly uses the selected first facility as the biller's authorized branch.

Authorize every invoice's facility inside the transaction or restrict claims to one authorized facility. Filter claim lists and subsequent claim operations using the same custody rule. Include mixed-facility inputs in regression tests.

### F6 — P1: Theatre scheduling double-books the surgeon and patient

[procedure.service.ts:199](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/procedures/procedure.service.ts:199).

The scheduling lock and overlap query cover only `theatreId`. Practitioner and patient availability are never claimed through the shared scheduling resource protocol. Moving the second case to another room bypasses all overlap protection, including conflicts with ordinary appointments.

**Reproduced:** two cases for the same patient and surgeon were both `SCHEDULED` for the identical one-hour interval in different theatres. No concurrency was necessary to trigger this.

Reserve the theatre, patient and each required practitioner atomically through shared resource calendars/claims, with applicable preparation and cleanup buffers. Release or replace claims on cancellation and rescheduling. Test separate theatres, cross-provider practitioner commitments and races with consultation booking.

### F7 — P2: Creating a referral now fails schema validation

[task.service.ts:301](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/task.service.ts:301), [clinical.model.ts:53](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/clinical.model.ts:53).

The shared clinical schema now requires `facilityId`; `Referral` uses that schema. `createReferral` still creates the record without the encounter's facility, so even a valid, authorized request cannot save.

**Reproduced:** a treating doctor referred a current encounter to an active seeded specialty and received `Referral validation failed: facilityId: Path 'facilityId' is required.`

Copy and validate the encounter's custody into the referral writer. Add a maintained create → receive → respond referral journey; the current passing suite misses this regression.

### F8 — P2: A partial remittance prematurely closes the insurance claim

[insurance.service.ts:505](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/insurance/insurance.service.ts:505), [insurance.service.ts:547](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/insurance/insurance.service.ts:547).

Settlement accepts any positive amount up to the approved amount, then always marks the claim `SETTLED` and closes its invoice associations. The state machine rejects later remittances. An unpaid approved balance is therefore treated like a closed claim, even though it has not been disallowed by the payer.

**Reproduced:** an approved claim of 1,000 minor units received 100, became `SETTLED`, and rejected the remaining 900 with `409`; the invoice still had 900 outstanding.

Track cumulative receipts and the remaining payer obligation. Keep partially paid claims open and close them only on full settlement or an explicit, audited final adjustment. If only single final remittances are supported, reject short payments instead of silently closing the claim.

### F9 — P2: The new clinical fields have no upgrade migration for existing data

[clinical.policy.ts:110](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/clinical.policy.ts:110), [clinical.model.ts:53](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/clinical/clinical.model.ts:53), [migrate.ts:15](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/database/migrate.ts:15).

Care authorization now requires an exact `membershipValidFrom` and facility-scoped assignments. Older assignments lack those fields. Older clinical facts also lack the newly required facility; aggregate facility filters exclude them, and saving affected heads can fail validation. The setup script creates indexes, upgrades roles and seeds catalogs/templates, but does not migrate these records. Previously dispensed `COMPLETED` medication orders also need an explicit compatibility decision under the new fulfillment model.

**Reproduced:** removing only the new membership/facility fields from an otherwise valid care assignment, to represent the previous persisted shape, changed an authorized clinician's chart read to `404`.

Before upgrading any populated database, provide a reviewed, idempotent migration with preview, provenance checks and an exception queue. Derive facility and membership generation only from trustworthy evidence; do not grant all old assignments blanket current authority or rewrite signed snapshots. Preserve genuinely stopped/completed medication orders. Add upgrade tests seeded with the previous document shapes. This finding is conditional on existing data; fresh-database tests cannot establish upgrade safety.

## What improved

The maintained regressions now pass for scanned-byte promotion, separate medical representative actions, the original branch summary/timeline leak, consent-period and recipient checks on shared documents, pharmacy stock scope, dispense-versus-administration lifecycle, suspended-doctor signing and initial/stale-lease payment-order recovery. These are meaningful fixes.

That evidence supports those tested paths, not every access route or every failure boundary. F1 shows the arrival check can still be bypassed through an allowed precursor action; F2/F3 show that fixing summary endpoints did not complete clinical access enforcement. F7 is a new schema/writer mismatch introduced by the facility change.

## Remaining design and release scope

The [completion tracker](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/docs/implementation/completion-tracker.md) itself still lists unfinished platform features: commission/settlement decisions, nursing assessments, care plans, safety incidents, formulary, stock reservations, specialist hospital modules and SMS/push/video/ABDM/payer integrations. Their absence is separate from the defects above; some were deliberately deferred in the design.

Additional limits confirmed by source inspection:

- Privacy export remains a capped JSON view, not a complete asynchronous export with pagination and a document manifest. It takes at most 500 appointments/invoices and calls clinical queries capped at 100 records per family. See [privacy.service.ts](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/privacy/privacy.service.ts).
- Subscription entitlement values are returned by the commerce query but are not enforced or metered in other domain commands. See [subscription.service.ts](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/modules/commerce/subscription.service.ts).
- OpenAPI generation supplies a route/security catalog and generic object request bodies, not the actual typed input/output contract needed for reliable client generation. See [openapi.ts:116](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/shared/http/openapi.ts:116).
- Readiness checks connectivity and replica-set capability; it does not verify required database indexes or completion of data upgrades. See [health.controller.ts](C:/Users/Adreesh/Desktop/docduniya/docduniya-backend/src/controllers/health.controller.ts).

Live merchant/webhook reconciliation, actual S3/ClamAV behavior, deployment, backup restoration and load acceptance remain unverified. This review identifies concrete blockers; it does not certify the absence of further defects.

Correct F1–F9, turn these scenarios into assertions of the intended behavior, and reconcile the completion claims before accepting the backend as complete.

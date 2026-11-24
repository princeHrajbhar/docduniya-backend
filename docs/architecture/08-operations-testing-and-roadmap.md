# Production operations and delivery roadmap

## Capacity assumptions and quality targets

These numbers are proposed planning inputs, not forecasts or measured performance. Revise them with launch-provider counts, specialty workflow and load-test evidence.

| Assumption                       | Example planning value                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Pilot providers / active doctors | 100 organizations / 500 doctors                                                                                    |
| Consultations                    | 30 per doctor/day = 15,000/day                                                                                     |
| Structured records/events        | 30 per consultation = 450,000/day; at 2 KB average about 0.9 GB/day before indexes, replicas and backups           |
| Patient file uploads             | 20% of consultations x one 2 MB file = about 6 GB/day before copies/versions                                       |
| API demand illustration          | 40 calls per consultation = 600,000/day, about 7 requests/second average; a 20x peak factor gives about 140/second |
| Concurrency validation           | 100 simultaneous attempts for one capacity-one interval; exactly one successful active booking                     |

These assumptions demonstrate why unbounded arrays, missing indexes, unrestricted exports and unplanned retention become expensive. Actual image/PACS volume may dominate everything above. Measure document size, index size, write amplification and aggregation latency before sizing production.

Proposed outpatient targets: 99.9% monthly API availability; p95 ordinary reads below 300 ms, p95 cached/public search below 700 ms, and p95 local booking transaction below 1 second under agreed load, excluding payment-provider latency. Define resource saturation, error budgets, and degraded states. Inpatient rollout needs a separate clinical availability and downtime review; the outpatient target is not automatically acceptable for bedside operations.

## Production topology and recovery

- Run at least two stateless API instances across failure zones behind TLS ingress. Workers scale by queue type. Graceful shutdown stops accepting new work, drains requests within a bound, and releases/lets leases expire safely.
- Use a supported MongoDB replica set with majority-durable financial/clinical writes, encrypted connections, least-privilege roles, point-in-time backup capability and restore rehearsals. Backups must cover immutable S3 versions and encryption-key availability, not just database rows.
- Use Redis with persistence/availability appropriate to BullMQ, no unintended eviction of queue keys, and monitored memory. MongoDB outbox remains the replay source after queue loss.
- Split file scanning/PDF CPU work from HTTP processes. Restrict scanners' network and filesystem permissions. A scanner outage leaves files quarantined.
- Use independent runtime, migration and incident-response identities. Keep production/staging accounts, secrets and datasets separated. Configure budgets and alerts before expensive storage/search exports.
- Proposed disaster targets: RPO at most 15 minutes and RTO at most 4 hours for the outpatient pilot, subject to backup provider capabilities and successful restore drills. These are targets requiring acceptance; transaction durability during ordinary failover and disaster RPO are different concepts.
- Recovery drill: restore DB/object versions into isolation, reconcile manifests/checksums, verify keys, rebuild indexes/projections, replay outbox/inbox safely, reconcile payment-provider state since backup, reapply retention deletions/holds and revoke affected sessions before controlled traffic restoration.
- Hospitals require paper/downtime patient identifiers, medication and specimen procedures, later reconciliation, and named responsibility. Offline bidirectional clinical editing is deferred until conflict and signature semantics are designed.

## Failure handling matrix

| Failure                            | Required behavior                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| MongoDB unavailable                | Reject unsafe writes; do not acknowledge lost webhooks; no Redis-only booking success                                                          |
| Transaction abort or retry         | Re-evaluate invariant checks, use stable operation IDs, never duplicate external calls inside callback                                         |
| Redis/queue outage                 | Persist outbox; core operations can continue where safe; show delayed payment setup/notifications; pause workflows needing external completion |
| Payment request timeout            | Persist unknown outcome; query/reconcile using stable references before creating another charge/refund                                         |
| Duplicate/out-of-order webhook     | Inbox dedupe, monotonic/state-aware processing, provider reconciliation                                                                        |
| Worker crash after external effect | Provider idempotency or lookup reconciles outcome; local dedupe alone cannot prevent all remote duplicates                                     |
| Expiry worker delayed              | Commands still reject expired holds; worker later records expiry using token/version guard                                                     |
| Notification provider down         | Retry and alert; booking/clinical state remains committed; critical-result workflow has escalation channels and owners                         |
| Search projection stale            | Recheck eligibility/availability/price in authoritative command; never trust search for access                                                 |
| S3 or scanner down                 | Metadata remains pending/quarantined; no unverified file access                                                                                |
| Audit/policy unavailable           | Sensitive disclosure fails closed; emergency fallback must use approved durable audit path                                                     |
| Doctor suspended                   | Stop new eligible actions, queue review of future bookings, preserve existing records and financial obligations                                |
| Provider offboards                 | Export/retention/settlement runbook; revoke access only through staged closure, never cascade delete                                           |

## Observability and operational owners

Monitor API latency/errors, DB connection pool/writes/conflicts, booking contention, orphan holds, outbox lag, retry/dead-letter age, webhook age, unmatched captures, refund/settlement aging, notification failures, scan backlog, unsigned notes, unacknowledged critical results, bed discrepancies, stock negatives/drift, backup age and restore success.

Assign each alert an owner and response procedure. Technical uptime monitoring does not replace clinical workflow monitoring. Logs use request and operation IDs with redacted data; tenant IDs and clinical resource IDs are protected operational metadata, not public analytics labels. Avoid patient IDs in high-cardinality metric labels.

## Validation gates

No tests are implemented by this design work. These scenarios define the checks required when implementation is authorized.

| Test area                  | Meaningful acceptance scenarios                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and authorization | Same user has different roles in two organizations; dependent access revoked; patient has no user; provider staff cannot enumerate global patients; platform admin cannot read charts by default                                            |
| Tenant integrity           | Substitute every resource ID in nested reads/writes/export/file endpoints; reject mismatched organization, patient, encounter, facility and order references                                                                                |
| Booking concurrency        | 100 concurrent identical holds; different starts with overlapping durations; same doctor at different clinics; shared room/device; overnight interval; cancellation racing confirmation; reschedule rollback; leave racing booking          |
| Expiry                     | Delayed sweeper; reused slot with old token; payment captured after expiry; client clock wrong; old worker cannot release a newer claim                                                                                                     |
| Clinical signing           | Concurrent note edits; item insertion during sign; revoked prescriber; signed payload mutation attempts; corrected result preserves original and alerts recipients; provenance and hash consistency                                         |
| Payments                   | Duplicate/reordered webhook; valid signature wrong merchant/amount; capture after cancellation; unknown network result; partial payment; one payment multiple invoices; concurrent refunds; credit without cash refund; settlement reversal |
| Documents                  | Forged MIME, excessive size, malware, archive bomb, replacement after scan, wrong S3 version, revoked grant, leaked URL expiry, document ownership mismatch                                                                                 |
| Events                     | Relay crash after publish; consumer crash before/after commit; replay; out-of-order projections; notification retry after reschedule/cancel                                                                                                 |
| Hospital                   | Concurrent bed transfers; ward isolation rules; wrong patient specimen; critical result not acknowledged; recalled/expired batch; concurrent last-stock dispense; partial/refill dispense; return quarantine                                |
| Operations                 | Replica-set failover, DB/queue outage, load shedding, restore from backup with object versions, payment reconciliation after restore, key recovery                                                                                          |
| Contract/integration       | OpenAPI compatibility, signed raw webhook bytes, partner sandbox, FHIR/profile validation, import dedupe, unknown codes and ambiguous patient identity                                                                                      |

Use the existing Vitest and Supertest setup for domain/API tests; run integration and concurrency tests against a real isolated replica set, not an in-memory substitute that omits transaction behavior. Add performance and security tooling only as needed. Test architecture import boundaries and explicitly inspect query plans for high-volume routes.

## Delivery phases and exit criteria

| Phase                       | Deliverable                                                                                                                                             | Exit gate                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 0 Product contracts         | Confirm launch capability set, provider custody contracts, roles, payment model, clinical governance, retention and policy owners                       | Decision register resolved for launch; architecture and threat model reviewed                           |
| 1 Foundation                | Scoped identity/membership, organization/facility, patient identity/registration, policies/audit, migration discipline, outbox/inbox, private documents | Multi-tenant and guardian isolation tests pass; backup/restore baseline verified                        |
| 2 Provider marketplace      | Doctor onboarding/qualifications/work history/verification, affiliations, service catalog, schedules, discovery and provider workspace                  | No unverified bookable provider; cross-facility identity and availability validated                     |
| 3 Complete outpatient slice | Patient intake -> resource-safe booking -> registration/queue -> encounter -> signed prescription -> patient access and follow-up                       | Concurrent booking/signing tests and privacy/access audit pass with clinician review                    |
| 4 Commercial operations     | Online/offline receipts, invoicing/credits/refunds, subscriptions, approved commissions/settlement, reconciliation and support                          | Financial invariants and provider sandbox reconciliation pass; disputed/late payment runbooks rehearsed |
| 5 Diagnostics and pharmacy  | Orders, specimens/results, critical-result review, dispense/stock/returns/procurement                                                                   | Clinical/lab/pharmacy acceptance and stock reconciliation pass                                          |
| 6 Hospital operations       | Admissions, beds/transfers, nursing/MAR, procedures, discharge and payer workflow                                                                       | Hospital operational simulation, downtime drill and clinical safety review pass                         |
| 7 Ecosystem expansion       | ABDM/FHIR and partner certification, advanced reporting, language/regional expansion, specialty modules                                                 | Contract-specific conformance, privacy review, scale tests and specialist acceptance                    |

For a pay-at-provider pilot, phases 3 and the basic invoice/receipt part of 4 can ship together. For prepaid marketplace launch, payment verification/refund/reconciliation is part of phase 3's release gate. Consent, audit, secure files and restore procedures are never postponed until after clinical production.

Calendar estimates require team size, existing-code assessment, partner onboarding and clinical/legal availability. Do not infer a reliable number of weeks from the number of collections.

## Minimum first implementation slice

Start with users/identities/sessions, organizations/facilities/memberships/assignments, patient identities/registrations/relationships, practitioners/doctors/credentials/affiliations, offerings/prices/policies, resources/schedules/calendar anchors/claims/appointments/history, visits/encounters/notes/observations/prescriptions/items/revisions/signatures, documents/consent/grants/audit, and operational outbox/inbox/idempotency.

Catalog seeds, a privacy notice, authorization tests, local MRN generation, clinician verification and a safe payment policy are dependencies of that slice. Some features can begin as bounded queries or externally managed catalogs; defer optional chat, advanced reviews/ranking, usage metering, insurer claims and inpatient collections until their workflow is ready.

## Migration from this repository

1. Inventory existing users, sessions, roles and asset ownership in a safe environment. Preserve IDs, working authentication and password hashes.
2. Add organization/membership/assignment concepts alongside the current single-role field. Map existing platform admins explicitly; no auto-upgrade to clinical authority.
3. Introduce policy evaluation behind a compatibility adapter, shadow-check decisions and validate account recovery. Cut over to scoped role assignments; retire the legacy role only after migration verification.
4. Reuse storage-provider adapters after review; introduce private clinical custody and scan pipeline. Existing public assets are not automatically patient documents. Do not silently change their visibility or repurpose their URLs.
5. Backfill only justified profile data, create professional/patient identities through explicit onboarding, and build reviewed unique indexes after duplicate checks.
6. Deploy expand/contract schema migrations with feature flags, synthetic fixtures, staged providers and rollback procedures. Monitor before enabling subsequent domains.

No existing source, dependency, schema, infrastructure or runtime setting is changed by this documentation package.

# Research and product scope

The target is an India-focused, multi-provider healthcare marketplace with a provider software subscription business. Hospitals, clinics, and solo doctors register independently; patients discover services, book, receive care, and access permitted records. The platform also supplies provider operations software.

## What established systems contribute

These are documented product capabilities and public domain models, not claims about proprietary databases. The design implications are recommendations for DocDuniya.

| Reference                                                                                                                                                                                           | Verified observation                                                                                                        | Design implication                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Practo Ray introduction](https://help.practo.com/practo-ray/getting-started/getting-started-with-ray/)                                                                                             | Appointment scheduling, patient records, billing, and follow-up belong to the practice workflow                             | Join discovery to provider operations; distinguish marketplace booking from the clinical record          |
| [OpenEMR features](https://www.open-emr.org/wiki/index.php/OpenEMR_Features)                                                                                                                        | Demographics, multiple facilities, scheduling, prescriptions, billing, portal, and access controls are separate concerns    | Include registration, care documentation, financial operations, and staff permissions from the beginning |
| [OpenMRS information model](https://openmrs.atlassian.net/wiki/spaces/docs/pages/515899478/OpenMRS%2BInformation%2BModel) and [visits](https://guide.openmrs.org/configuration/configuring-visits/) | Patients, providers, encounters, and visits have distinct meanings; a visit groups related encounters                       | Do not collapse a hospital visit or admission into one appointment document                              |
| [Bahmni features](https://www.bahmni.org/feature-list/)                                                                                                                                             | Hospital workflows include registration, clinical services, orders, samples, admission, beds, stock, billing, and reporting | Plan a hospital domain beyond the outpatient marketplace                                                 |
| [Bahmni PACS integration](https://www.bahmni.org/pacs-integration)                                                                                                                                  | Imaging integration is a separate capability                                                                                | Reference imaging studies and integrate with PACS; uploading a PDF is not a radiology information system |

Public documentation establishes useful domain boundaries. It does not prove that an implementation is correct, safe for clinical deployment, or legally compliant.

## Standards and engineering findings

| Finding and primary source                                                                                                                                     | Decision for this design                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [FHIR Appointment](https://hl7.org/fhir/R4/appointment.html) separates a planned booking from the encounters that may follow                                   | Permit zero or multiple encounters per appointment; walk-ins need no appointment                                  |
| [FHIR Encounter](https://hl7.org/fhir/R4/encounter.html) supports different care settings and aggregation                                                      | Use visits plus encounters; model admission separately as an operational aggregate linked to the inpatient visit  |
| [FHIR PractitionerRole](https://hl7.org/fhir/R4/practitionerrole.html) represents a professional's services and locations at an organization over time         | Use time-bounded doctor affiliations and facility-specific service offerings                                      |
| [FHIR MedicationRequest](https://hl7.org/fhir/R4/medicationrequest.html) distinguishes orders, dispensing, administration, and reported medication use         | Keep prescriptions, prescription items, medication statements, dispensing, and administration distinct            |
| [FHIR DiagnosticReport](https://hl7.org/fhir/R4/diagnosticreport.html) links context, results, and formatted reports                                           | Store structured observations separately from report documents and service orders                                 |
| [FHIR Consent](https://hl7.org/fhir/R4/consent.html) represents scoped permissions and restrictions                                                            | Store recipient, purpose, resource scope, period, evidence, and withdrawal; evaluate access server-side           |
| [FHIR security](https://hl7.org/fhir/R4/security.html) explicitly leaves authentication and authorization to other mechanisms                                  | FHIR-shaped JSON does not grant access or establish compliance                                                    |
| [MongoDB modeling](https://www.mongodb.com/docs/manual/data-modeling/) starts from access patterns                                                             | Embed bounded value objects and snapshots; reference independently managed or growing records                     |
| [MongoDB atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/) distinguishes single-document writes and multi-document transactions | Use conditional writes and small transactions for booking, billing allocation, and inventory                      |
| [MongoDB TTL](https://www.mongodb.com/docs/manual/core/index-ttl/) does not delete exactly at expiry                                                           | Check expiry in commands; never use TTL as the booking release mechanism                                          |
| [Mongoose validation](https://mongoosejs.com/docs/validation.html) says `unique` is not a validator                                                            | Create and verify database indexes through migrations; handle duplicate-key errors                                |
| [Mongoose concurrency](https://mongoosejs.com/docs/guide.html#optimisticConcurrency) concerns load/save races                                                  | Use explicit version predicates for atomic query updates as well                                                  |
| [Mongoose transactions](https://mongoosejs.com/docs/transactions.html) disallow parallel operations in one transaction                                         | Every operation in a transaction uses its session and executes sequentially                                       |
| [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs) describes retry-safe processing                                                      | Transactional outbox plus consumer deduplication; external effects still need provider idempotency/reconciliation |
| [Razorpay webhooks](https://razorpay.com/docs/webhooks/validate-test/) may repeat or arrive out of order                                                       | Validate raw bytes and signature, persist an inbox, and apply business transitions idempotently                   |
| [S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) can be reused before expiry                                | Use short lifetimes, immutable version-specific objects, quarantine, and current authorization before issuance    |

## India context

Use Indian addresses, state/UT and district codes where needed, `Asia/Kolkata` as the initial facility timezone, INR money, multilingual names and communication preferences, and country-specific professional registration. Store country and timezone explicitly so these defaults are not hard-coded into every model.

The [ABDM implementation guide](https://nrces.in/ndhm/fhir/r4/) available during this review identifies version 6.5.0 and uses FHIR R4. The integration boundary should pin the version required by the actual partner/certification process. Keep internal models purpose-built and transform them into validated profiles. This avoids assuming that the newest generic FHIR release is necessarily the correct ABDM target.

ABHA must not become the database primary key or the only way to register a patient. The [NHA HIP/HIU guidelines](https://abdm.gov.in/strapicms/uploads/HIP_HIU_Guidelines_f85df336ec.pdf) describe voluntary ABHA creation and consent-based exchange. Store external identifiers with issuer, verification status, and restricted visibility. Support unlinked patients and later verified linking.

The DPDP Act and Rules have phased commencement. The [Act commencement notification](https://www.meity.gov.in/static/uploads/2025/11/c56ceae6c383460ca69577428d36828b.pdf) and [Rules, rule 1](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf?v=20261027115856) specify publication, one-year, and eighteen-month stages. As of this design's date, do not describe the entire regime as already fully operative. Maintain an effective-date legal register and have Indian counsel validate the actual deployment obligations, contracts, retention periods, children's data rules, and applicable exemptions. Build notice records, purpose restrictions, guardian verification, withdrawal, requests, incident response, and retention controls now.

Telemedicine policy must be reviewed against the applicable NMC rules and current guidance before release. Capture mode, consent evidence, prescriber registration, patient location where needed, and policy version; make prescription restrictions configurable and clinician-governed. The official [2020 gazette reference](https://www.nmc.org.in/MCIRest/open/getDocument?path=%2FDocuments%2FPublic%2FPortal%2FLatestNews%2FTelemedicine+140520.pdf) was discoverable but its full body was inaccessible in this review; this design does not assert a complete current legal rule set from it.

Terminology versions and usage rights matter. [SNOMED International](https://www.snomed.org/get-snomed) explains registration and licensing arrangements. Do not import a commercial drug catalog or terminology set merely because a downloadable copy exists. Select licensed local drug data; record code system, version, and display snapshot. LOINC, UCUM, and ICD mappings require their own implementation review.

## Product capabilities and release scope

| Area                  | Required capability                                                                                     | Delivery track                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Marketplace           | Provider search, doctor/facility pages, languages, modes, fees, distance, availability, reviews         | Core                              |
| Provider onboarding   | Legal organization, facilities, owner/admin membership, credential verification, solo practice          | Core                              |
| Identity              | Patient, practitioner and staff access; MFA; guardians; invitations; account recovery                   | Core                              |
| Outpatient operations | Registration/MRN, queue, consultation, allergy review, clinical notes, orders, prescriptions, follow-up | Core                              |
| Finance               | Quote, charges, invoice, receipt, online/offline payments, refunds, reconciliation                      | Core                              |
| Platform commerce     | Subscription plans, entitlements, provider contracts, commissions, settlement and disputes              | Core when monetization is enabled |
| Privacy               | Custody, consent, authorized sharing, read/write audit, retention, export, correction                   | Core                              |
| Hospital operations   | Emergency triage, admissions, transfers, beds, nursing, discharge, ongoing billing                      | Hospital track                    |
| Diagnostics           | Orders, specimens, results, verification, critical-result acknowledgement, imaging references           | Hospital/partner track            |
| Pharmacy              | Drug catalog, dispense/return, batch/expiry, stock movements and procurement                            | Hospital/partner track            |
| Insurance             | Coverage, eligibility evidence, authorization, claim, remittance, denial and appeal                     | Payer track                       |
| Procedures            | OT bookings, team, consent, checklist, procedure/anesthesia records and recovery                        | Hospital specialty track          |
| Integration           | ABDM, FHIR, LIS, PACS, payment, communications and accounting                                           | Partner-specific track            |

Blood-bank donor screening and crossmatch, organ transplant, dialysis device integration, ICU waveforms, radiotherapy, fertility/embryology, pathology image analysis, ambulance dispatch, HR/payroll, kitchen/laundry, and biomedical maintenance are **not implied to be complete** by the common hospital model. Their boundaries are identified in the extension dictionary; each requires specialist workflow and jurisdiction review if included in a launch contract.

## Revisions to the supplied research

The drafts correctly emphasize a modular monolith, separate clinical history, transactional booking, private documents, and audited sharing. The principal gaps were tenancy, organization ownership, staff outside the three portal roles, dependent registration, doctor work history, immutable clinical versions, overlapping reservations, payment allocation, partial refunds, subscriptions, settlements, diagnostic orders, admission/nursing/stock, and operational recovery.

Do not force every logical relationship into a collection: addresses and weekly rules can be bounded embedded values. Conversely, don't embed appointment history, prescriptions, messages, or audit trails in a patient. Keep the physical schema aligned with independent lifecycle, query needs, and consistency rules.

import mongoose from 'mongoose';
import { User } from '../modules/admin/auth/models/user.model.js';
import { Session } from '../modules/admin/auth/models/session.model.js';
import { AccessRole } from '../modules/admin/auth/roles/role.model.js';
import { MfaChallenge, MfaFactor } from '../modules/admin/auth/mfa/mfa.model.js';
import { AdminSignInChallenge } from '../modules/admin/auth/models/admin-signin.model.js';
import {
  Organization,
  Facility,
  VerificationCase,
} from '../modules/organizations/organization.model.js';
import { Membership, ScopedRole, RoleAssignment } from '../modules/access/access.model.js';
import { DoctorVerificationCase, DoctorAffiliation } from '../modules/providers/provider.model.js';
import {
  Patient,
  PatientRelationship,
  PatientRegistration,
  PatientMergeCase,
} from '../modules/patients/patient.model.js';
import {
  Practitioner,
  Doctor,
  Specialty,
  PractitionerQualification,
  PractitionerEmployment,
  ProfessionalRegistration,
} from '../modules/practitioners/practitioner.model.js';
import {
  AuditEvent,
  OutboxEvent,
  IdempotencyKey,
  NumberSequence,
} from '../modules/operations/operation.model.js';
import {
  FacilityResource,
  ServiceOffering,
  Price,
  ScheduleRule,
  ResourceCalendarDay,
  ResourceClaim,
  ScheduleException,
} from '../modules/scheduling/scheduling.model.js';
import {
  Appointment,
  AppointmentHistory,
  QueueEntry,
} from '../modules/appointments/appointment.model.js';
import * as billing from '../modules/billing/billing.model.js';
import * as privacy from '../modules/privacy/privacy.model.js';
import * as documents from '../modules/documents/document.model.js';
import * as clinical from '../modules/clinical/clinical.model.js';
import * as diagnostics from '../modules/diagnostics/diagnostic.model.js';
import { FacilityLocation } from '../modules/locations/location.model.js';
import * as pharmacy from '../modules/pharmacy/pharmacy.model.js';
import * as inpatient from '../modules/inpatient/inpatient.model.js';
import * as notifications from '../modules/notifications/notification.model.js';
import * as engagement from '../modules/engagement/engagement.model.js';
import { Subscription, SubscriptionPlan } from '../modules/commerce/subscription.service.js';
import { ProfessionalCredentialReview } from '../modules/practitioners/credential.model.js';
import * as intake from '../modules/intake/intake.model.js';
import { WaitlistEntry } from '../modules/appointments/waitlist.model.js';
import * as messaging from '../modules/messaging/messaging.model.js';
import * as insurance from '../modules/insurance/insurance.model.js';
import * as procedures from '../modules/procedures/procedure.model.js';

export const foundationModels = [
  Organization,
  Facility,
  VerificationCase,
  Membership,
  ScopedRole,
  RoleAssignment,
  Patient,
  PatientRelationship,
  PatientRegistration,
  PatientMergeCase,
  Practitioner,
  Doctor,
  Specialty,
  PractitionerQualification,
  PractitionerEmployment,
  ProfessionalRegistration,
  ProfessionalCredentialReview,
  // Intake and routing
  intake.Questionnaire,
  intake.QuestionnaireAssignment,
  intake.IntakeResponse,
  intake.ConcernMapping,
  WaitlistEntry,
  messaging.Conversation,
  messaging.ConversationMessage,
  // Insurance and claims
  insurance.Payer,
  insurance.InsuranceCoverage,
  insurance.Preauthorization,
  insurance.InsuranceClaim,
  insurance.ClaimInvoice,
  // Theatre and procedures
  procedures.ProcedureCase,
  procedures.TheatreLock,
  AuditEvent,
  OutboxEvent,
  IdempotencyKey,
  NumberSequence,
  DoctorVerificationCase,
  DoctorAffiliation,
  // Services, scheduling and booking
  FacilityResource,
  ServiceOffering,
  Price,
  ScheduleRule,
  ResourceCalendarDay,
  ResourceClaim,
  ScheduleException,
  Appointment,
  AppointmentHistory,
  QueueEntry,
  // Billing, payments and ledger
  billing.MerchantAccount,
  billing.ChargeItem,
  billing.Invoice,
  billing.InvoiceItem,
  billing.CreditNote,
  billing.PaymentIntent,
  billing.Payment,
  billing.PaymentAllocation,
  billing.Refund,
  billing.PaymentDispute,
  billing.LedgerAccount,
  billing.LedgerJournal,
  billing.InboxEvent,
  billing.ReconciliationRun,
  billing.ReconciliationItem,
  // Privacy, consent and documents
  privacy.PolicyVersion,
  privacy.PolicyAcknowledgement,
  privacy.Consent,
  privacy.ConsentEvent,
  privacy.AccessGrant,
  privacy.PrivacyRequest,
  privacy.RetentionHold,
  documents.ClinicalDocument,
  documents.DocumentVersion,
  documents.DocumentLink,
  // Clinical records
  clinical.Visit,
  clinical.Encounter,
  clinical.CareTeamAssignment,
  clinical.Allergy,
  clinical.Condition,
  clinical.MedicationStatement,
  clinical.Immunization,
  clinical.Observation,
  clinical.ClinicalNote,
  clinical.Diagnosis,
  clinical.Prescription,
  clinical.PrescriptionItem,
  clinical.ClinicalRevision,
  clinical.RecordSignature,
  clinical.ClinicalTask,
  clinical.Referral,
  // Diagnostics
  diagnostics.DiagnosticTest,
  diagnostics.ServiceOrder,
  diagnostics.Specimen,
  diagnostics.DiagnosticReport,
  diagnostics.ImagingStudy,
  // Hospital operations, pharmacy and stock
  FacilityLocation,
  inpatient.Admission,
  inpatient.BedAssignment,
  inpatient.MedicationAdministration,
  inpatient.FluidBalanceEntry,
  inpatient.DischargePlan,
  pharmacy.DrugCatalogItem,
  pharmacy.InventoryItem,
  pharmacy.Supplier,
  pharmacy.StockBatch,
  pharmacy.StockBalance,
  pharmacy.StockMovement,
  pharmacy.PurchaseOrder,
  pharmacy.GoodsReceipt,
  pharmacy.Dispense,
  // Communication, engagement and commerce
  notifications.NotificationTemplate,
  notifications.Notification,
  notifications.ProcessedEvent,
  engagement.SupportTicket,
  engagement.Review,
  SubscriptionPlan,
  Subscription,
] as const;

/** Explicit, additive deployment step. Never drops indexes or silently repairs duplicate data. */
export async function initializeFoundation(): Promise<void> {
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid')
    throw new Error('Foundation requires a MongoDB replica set or sharded cluster');
  for (const entry of [
    User,
    Session,
    AccessRole,
    MfaFactor,
    MfaChallenge,
    AdminSignInChallenge,
    ...foundationModels,
  ]) {
    await entry.createCollection();
    await entry.createIndexes();
  }
}

// Local navigation codes, not a licensed clinical terminology or diagnostic mapping.
export const starterSpecialties = [
  { code: 'LOCAL_GENERAL_MEDICINE', name: 'General medicine' },
  { code: 'LOCAL_PAEDIATRICS', name: 'Paediatrics' },
  { code: 'LOCAL_DERMATOLOGY', name: 'Dermatology' },
  { code: 'LOCAL_CARDIOLOGY', name: 'Cardiology' },
  { code: 'LOCAL_ORTHOPAEDICS', name: 'Orthopaedics' },
  { code: 'LOCAL_OBSTETRICS_GYNAECOLOGY', name: 'Obstetrics and gynaecology' },
];

export async function seedStarterSpecialties(): Promise<void> {
  const actor = { kind: 'SERVICE' as const, id: 'foundation-initializer-v1' };
  for (const specialty of starterSpecialties) {
    await Specialty.updateOne(
      { code: specialty.code },
      { $setOnInsert: { ...specialty, createdBy: actor, updatedBy: actor } },
      { upsert: true, runValidators: true },
    );
  }
}

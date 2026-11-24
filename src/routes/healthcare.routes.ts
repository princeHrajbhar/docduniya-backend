import { Router, type Request } from 'express';
import { protect, requirePermission } from '../modules/admin/auth/auth.middleware.js';
import { PERMISSIONS } from '../modules/admin/auth/roles/permission.constants.js';
import { actor, idempotencyKey, param } from '../shared/http/context.js';
import { objectId, paginationInput } from '../shared/domain/healthcare.js';
import * as organizations from '../modules/organizations/organization.service.js';
import * as organizationDto from '../modules/organizations/organization.validation.js';
import * as memberships from '../modules/access/membership.service.js';
import * as membershipDto from '../modules/access/membership.validation.js';
import * as patients from '../modules/patients/patient.service.js';
import * as patientDto from '../modules/patients/patient.validation.js';
import * as practitioners from '../modules/practitioners/practitioner.service.js';
import * as practitionerDto from '../modules/practitioners/practitioner.validation.js';

const id = (req: Request, key: string) => objectId.parse(param(req, key));
const page = (req: Request) => paginationInput.parse(req.query);
const root = Router();
const organization = Router();
organization.post('/', async (req, res) =>
  res.status(201).json({
    success: true,
    data: await organizations.createOrganization(
      actor(req),
      organizationDto.organizationInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
organization.get('/:organizationId', async (req, res) =>
  res.json({
    success: true,
    data: await organizations.getOrganization(actor(req), id(req, 'organizationId')),
  }),
);
organization.patch('/:organizationId', async (req, res) =>
  res.json({
    success: true,
    data: await organizations.updateOrganization(
      actor(req),
      id(req, 'organizationId'),
      organizationDto.updateOrganizationInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
organization.post('/:organizationId/facilities', async (req, res) =>
  res.status(201).json({
    success: true,
    data: await organizations.createFacility(
      actor(req),
      id(req, 'organizationId'),
      organizationDto.facilityInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
organization.get('/:organizationId/facilities', async (req, res) =>
  res.json({
    success: true,
    data: await organizations.listFacilities(actor(req), id(req, 'organizationId'), page(req)),
  }),
);
organization.patch('/:organizationId/facilities/:facilityId', async (req, res) =>
  res.json({
    success: true,
    data: await organizations.updateFacility(
      actor(req),
      id(req, 'organizationId'),
      id(req, 'facilityId'),
      organizationDto.updateFacilityInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
organization.post('/:organizationId/facilities/:facilityId/state', async (req, res) =>
  res.json({
    success: true,
    data: await organizations.changeFacilityState(
      actor(req),
      id(req, 'organizationId'),
      id(req, 'facilityId'),
      organizationDto.facilityStateInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
organization.post('/:organizationId/submit-verification', async (req, res) =>
  res.json({
    success: true,
    data: await organizations.submitVerification(
      actor(req),
      id(req, 'organizationId'),
      organizationDto.submitVerificationInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
organization.post('/:organizationId/memberships', async (req, res) =>
  res.status(201).json({
    success: true,
    data: await memberships.inviteMember(
      actor(req),
      id(req, 'organizationId'),
      membershipDto.inviteInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
organization.get('/:organizationId/memberships', async (req, res) =>
  res.json({
    success: true,
    data: await memberships.listMemberships(actor(req), page(req), id(req, 'organizationId')),
  }),
);
organization.post('/:organizationId/memberships/:membershipId/state', async (req, res) =>
  res.json({
    success: true,
    data: await memberships.changeMembership(
      actor(req),
      id(req, 'organizationId'),
      id(req, 'membershipId'),
      membershipDto.membershipStateInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
organization.post('/:organizationId/patient-registrations', async (req, res) =>
  res.status(201).json({
    success: true,
    data: await patients.createProviderRegistration(
      actor(req),
      id(req, 'organizationId'),
      patientDto.registrationInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
organization.get('/:organizationId/patient-registrations', async (req, res) =>
  res.json({
    success: true,
    data: await patients.listRegistrations(
      actor(req),
      id(req, 'organizationId'),
      patientDto.registrationQuery.parse(req.query),
    ),
  }),
);
organization.get('/:organizationId/patient-registrations/:registrationId', async (req, res) =>
  res.json({
    success: true,
    data: await patients.getRegistration(
      actor(req),
      id(req, 'organizationId'),
      id(req, 'registrationId'),
    ),
  }),
);
organization.patch('/:organizationId/patient-registrations/:registrationId', async (req, res) =>
  res.json({
    success: true,
    data: await patients.updateRegistration(
      actor(req),
      id(req, 'organizationId'),
      id(req, 'registrationId'),
      patientDto.updateRegistrationInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
root.use('/organizations', protect, organization);

const me = Router();
me.get('/memberships', async (req, res) =>
  res.json({ success: true, data: await memberships.listMemberships(actor(req), page(req)) }),
);
me.post('/memberships/:membershipId/accept', async (req, res) =>
  res.json({
    success: true,
    data: await memberships.acceptInvitation(
      actor(req),
      id(req, 'membershipId'),
      membershipDto.acceptInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
me.get('/patients', async (req, res) =>
  res.json({ success: true, data: await patients.listOwnPatients(actor(req), page(req)) }),
);
me.get('/patient-relationships', async (req, res) =>
  res.json({ success: true, data: await patients.listOwnRelationships(actor(req), page(req)) }),
);
me.post('/patient-relationships/:relationshipId/revoke', async (req, res) =>
  res.json({
    success: true,
    data: await patients.revokeRelationship(
      actor(req),
      id(req, 'relationshipId'),
      patientDto.revokeRelationshipInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
root.use('/me', protect, me);

const patient = Router();
patient.post('/', async (req, res) =>
  res.status(201).json({
    success: true,
    data: await patients.createPatient(
      actor(req),
      patientDto.createPatientInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
patient.get('/:patientId/profile', async (req, res) =>
  res.json({ success: true, data: await patients.getPatient(actor(req), id(req, 'patientId')) }),
);
patient.patch('/:patientId/profile', async (req, res) =>
  res.json({
    success: true,
    data: await patients.updatePatient(
      actor(req),
      id(req, 'patientId'),
      patientDto.updatePatientInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
patient.post('/:patientId/registrations', async (req, res) =>
  res.status(201).json({
    success: true,
    data: await patients.registerSelfAtProvider(
      actor(req),
      id(req, 'patientId'),
      patientDto.selfRegistrationInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
root.use('/patients', protect, patient);

const practitioner = Router();
practitioner.post('/me', async (req, res) =>
  res.status(201).json({
    success: true,
    data: await practitioners.createPractitioner(
      actor(req),
      practitionerDto.practitionerInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
practitioner.get('/me', async (req, res) =>
  res.json({ success: true, data: await practitioners.getPractitioner(actor(req)) }),
);
practitioner.patch('/me', async (req, res) =>
  res.json({
    success: true,
    data: await practitioners.updatePractitioner(
      actor(req),
      practitionerDto.updatePractitionerInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
practitioner.post('/me/qualifications', async (req, res) =>
  res.status(201).json({
    success: true,
    data: await practitioners.addCredential(
      actor(req),
      'qualifications',
      practitionerDto.qualificationInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
practitioner.post('/me/employment', async (req, res) =>
  res.status(201).json({
    success: true,
    data: await practitioners.addCredential(
      actor(req),
      'employment',
      practitionerDto.employmentInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
practitioner.post('/me/registrations', async (req, res) =>
  res.status(201).json({
    success: true,
    data: await practitioners.addCredential(
      actor(req),
      'registrations',
      practitionerDto.professionalRegistrationInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
for (const kind of ['qualifications', 'employment', 'registrations'] as const)
  practitioner.get(`/me/${kind}`, async (req, res) =>
    res.json({
      success: true,
      data: await practitioners.listCredentials(actor(req), kind, page(req)),
    }),
  );
root.use('/practitioners', protect, practitioner);

const doctor = Router();
doctor.post('/me', async (req, res) =>
  res.status(201).json({
    success: true,
    data: await practitioners.createDoctor(
      actor(req),
      practitionerDto.doctorInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
doctor.get('/me', async (req, res) =>
  res.json({ success: true, data: await practitioners.getDoctor(actor(req)) }),
);
doctor.patch('/me', async (req, res) =>
  res.json({
    success: true,
    data: await practitioners.updateDoctor(
      actor(req),
      practitionerDto.updateDoctorInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
root.use('/doctors', protect, doctor);
root.get('/specialties', async (req, res) =>
  res.json({ success: true, data: await practitioners.listSpecialties(page(req)) }),
);

const platform = Router();
platform.get(
  '/provider-verifications',
  requirePermission(PERMISSIONS.PROVIDERS_VERIFY),
  async (req, res) =>
    res.json({ success: true, data: await organizations.listVerifications(actor(req), page(req)) }),
);
platform.post(
  '/provider-verifications/:verificationId/decide',
  requirePermission(PERMISSIONS.PROVIDERS_VERIFY),
  async (req, res) =>
    res.json({
      success: true,
      data: await organizations.decideVerification(
        actor(req),
        id(req, 'verificationId'),
        organizationDto.verificationDecisionInput.parse(req.body),
        idempotencyKey(req),
      ),
    }),
);
platform.get(
  '/patient-relationship-requests',
  requirePermission(PERMISSIONS.PATIENT_RELATIONSHIPS_VERIFY),
  async (req, res) =>
    res.json({
      success: true,
      data: await patients.listRelationshipRequests(actor(req), page(req)),
    }),
);
platform.post(
  '/patient-relationship-requests/:relationshipId/decide',
  requirePermission(PERMISSIONS.PATIENT_RELATIONSHIPS_VERIFY),
  async (req, res) =>
    res.json({
      success: true,
      data: await patients.decideRelationship(
        actor(req),
        id(req, 'relationshipId'),
        patientDto.relationshipDecisionInput.parse(req.body),
        idempotencyKey(req),
      ),
    }),
);
root.use('/platform', protect, platform);
export default root;

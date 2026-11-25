import { Router } from 'express';
import healthRoutes from './health.routes.js';
import { authRoutes, roleRoutes } from '../modules/admin/auth/index.js';
import { userRoutes } from '../modules/users/index.js';
import { managedFileRoutes } from '../modules/managed-files/index.js';
import { assetRoutes } from '../modules/assets/index.js';
import emailRoutes from '../modules/email/email.routes.js';
import { blogRoutes } from '../modules/admin/blog/index.js';
import { blogCategoryRoutes } from '../modules/admin/blogCategories/index.js';
import healthcareRoutes from './healthcare.routes.js';
import providerRoutes from '../modules/providers/provider.routes.js';
import bookingRoutes from '../modules/appointments/booking.routes.js';
import billingRoutes from '../modules/billing/billing.routes.js';
import accessRoutes from '../modules/access/access.routes.js';
import clinicalRoutes from '../modules/clinical/clinical.routes.js';
import diagnosticRoutes from '../modules/diagnostics/diagnostic.routes.js';
import documentRoutes from '../modules/documents/document.routes.js';
import privacyRoutes from '../modules/privacy/privacy.routes.js';
import inpatientRoutes from '../modules/inpatient/inpatient.routes.js';
import pharmacyRoutes from '../modules/pharmacy/pharmacy.routes.js';
import engagementRoutes from '../modules/engagement/engagement.routes.js';
import credentialRoutes from '../modules/practitioners/credential.routes.js';
import intakeRoutes from '../modules/intake/intake.routes.js';
import waitlistRoutes from '../modules/appointments/waitlist.routes.js';
import messagingRoutes from '../modules/messaging/messaging.routes.js';
import mergeRoutes from '../modules/patients/merge.routes.js';
import insuranceRoutes from '../modules/insurance/insurance.routes.js';
import procedureRoutes from '../modules/procedures/procedure.routes.js';
import { webhookRouter } from '../modules/billing/billing.routes.js';
import { buildOpenApi } from '../shared/http/openapi.js';

/**
 * Route registry, in matching order. The same list mounts the API and generates the OpenAPI
 * contract, so the published contract cannot drift from the served routes.
 */
export const ROUTE_GROUPS: Array<{ tag: string; prefix?: string; router: Router }> = [
  { tag: 'Health', prefix: '/health', router: healthRoutes },
  { tag: 'Authentication', prefix: '/auth', router: authRoutes },
  { tag: 'Platform roles', prefix: '/roles', router: roleRoutes },
  { tag: 'Platform users', prefix: '/users', router: userRoutes },
  { tag: 'Files', prefix: '/files', router: managedFileRoutes },
  { tag: 'Media assets', prefix: '/assets', router: assetRoutes },
  { tag: 'Email administration', prefix: '/email', router: emailRoutes },
  { tag: 'Blog', prefix: '/blogs', router: blogRoutes },
  { tag: 'Blog categories', prefix: '/blog-categories', router: blogCategoryRoutes },
  { tag: 'Providers and doctors', router: providerRoutes },
  // Public review listings live under /doctors and must be matched before the protected doctor router.
  { tag: 'Engagement and operations', router: engagementRoutes },
  { tag: 'Booking and scheduling', router: bookingRoutes },
  { tag: 'Billing, payments and ledger', router: billingRoutes },
  { tag: 'Organization access', router: accessRoutes },
  { tag: 'Clinical records', router: clinicalRoutes },
  { tag: 'Diagnostics', router: diagnosticRoutes },
  { tag: 'Private documents', router: documentRoutes },
  { tag: 'Privacy, consent and audit', router: privacyRoutes },
  { tag: 'Inpatient and locations', router: inpatientRoutes },
  { tag: 'Pharmacy and stock', router: pharmacyRoutes },
  { tag: 'Professional credentials', router: credentialRoutes },
  { tag: 'Intake and concern routing', router: intakeRoutes },
  { tag: 'Waitlist', router: waitlistRoutes },
  { tag: 'Secure messaging', router: messagingRoutes },
  { tag: 'Patient identity', router: mergeRoutes },
  { tag: 'Insurance and claims', router: insuranceRoutes },
  { tag: 'Theatre and procedures', router: procedureRoutes },
  { tag: 'Organizations, patients and practitioners', router: healthcareRoutes },
];

const router = Router();
let contract: ReturnType<typeof buildOpenApi> | undefined;
// The contract is public: it describes shapes and requirements, never data.
router.get('/openapi.json', (_req, res) => {
  contract ??= buildOpenApi(ROUTE_GROUPS, {
    version: process.env.npm_package_version ?? '1.0.0',
    extra: [{ tag: 'Payment webhooks', prefix: '/webhooks', router: webhookRouter }],
  });
  res.set('Cache-Control', 'public, max-age=300').json(contract);
});
for (const group of ROUTE_GROUPS)
  if (group.prefix) router.use(group.prefix, group.router);
  else router.use(group.router);

export default router;

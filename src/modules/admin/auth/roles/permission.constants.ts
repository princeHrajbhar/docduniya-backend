export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard.view',
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  FILES_MANAGE: 'files.manage',
  ASSETS_MANAGE: 'assets.manage',
  EMAIL_MANAGE: 'email.manage',
  BLOGS_MANAGE: 'blogs.manage',
  BLOG_CATEGORIES_MANAGE: 'blog-categories.manage',
  PROVIDERS_VERIFY: 'providers.verify',
  DOCTORS_VERIFY: 'doctors.verify',
  PATIENT_RELATIONSHIPS_VERIFY: 'patient-relationships.verify',
  MERCHANTS_VERIFY: 'merchants.verify',
  CATALOG_MANAGE: 'catalog.manage',
  COMMERCE_MANAGE: 'commerce.manage',
  SUPPORT_MANAGE: 'support.manage',
  REVIEWS_MODERATE: 'reviews.moderate',
  PRIVACY_MANAGE: 'privacy.manage',
  AUDIT_READ: 'audit.read',
  OPERATIONS_MANAGE: 'operations.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export const isPermission = (value: unknown): value is Permission =>
  typeof value === 'string' && (ALL_PERMISSIONS as string[]).includes(value);

/** Catalog shown in the admin role editor. */
export const PERMISSION_GROUPS = [
  { key: PERMISSIONS.DASHBOARD_VIEW, label: 'Dashboard overview', module: 'Dashboard' },
  { key: PERMISSIONS.USERS_MANAGE, label: 'Users', module: 'Accounts' },
  { key: PERMISSIONS.ROLES_MANAGE, label: 'Roles and permissions', module: 'Security' },
  { key: PERMISSIONS.FILES_MANAGE, label: 'File manager', module: 'Files' },
  { key: PERMISSIONS.ASSETS_MANAGE, label: 'Media library', module: 'Files' },
  {
    key: PERMISSIONS.EMAIL_MANAGE,
    label: 'Email suppression and delivery logs',
    module: 'Communication',
  },
  { key: PERMISSIONS.BLOGS_MANAGE, label: 'Blog posts', module: 'Content' },
  { key: PERMISSIONS.BLOG_CATEGORIES_MANAGE, label: 'Blog categories', module: 'Content' },
  {
    key: PERMISSIONS.PROVIDERS_VERIFY,
    label: 'Provider verification',
    module: 'Provider onboarding',
  },
  {
    key: PERMISSIONS.PATIENT_RELATIONSHIPS_VERIFY,
    label: 'Representative authority verification',
    module: 'Privacy',
  },
  {
    key: PERMISSIONS.DOCTORS_VERIFY,
    label: 'Doctor credential review and restrictions',
    module: 'Provider onboarding',
  },
  { key: PERMISSIONS.MERCHANTS_VERIFY, label: 'Payment merchant activation', module: 'Finance' },
  {
    key: PERMISSIONS.CATALOG_MANAGE,
    label: 'Drug, diagnostic test and clinical concept catalogs',
    module: 'Catalog',
  },
  { key: PERMISSIONS.COMMERCE_MANAGE, label: 'Subscription plans', module: 'Commerce' },
  { key: PERMISSIONS.SUPPORT_MANAGE, label: 'Support tickets', module: 'Support' },
  { key: PERMISSIONS.REVIEWS_MODERATE, label: 'Review moderation', module: 'Marketplace' },
  { key: PERMISSIONS.PRIVACY_MANAGE, label: 'Privacy requests', module: 'Privacy' },
  { key: PERMISSIONS.AUDIT_READ, label: 'Platform audit events', module: 'Security' },
  {
    key: PERMISSIONS.OPERATIONS_MANAGE,
    label: 'Event delivery, reconciliation and recovery',
    module: 'Operations',
  },
] as const;

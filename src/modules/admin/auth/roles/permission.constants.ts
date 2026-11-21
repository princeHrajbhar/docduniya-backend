export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard.view',
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  FILES_MANAGE: 'files.manage',
  ASSETS_MANAGE: 'assets.manage',
  EMAIL_MANAGE: 'email.manage',
  BLOGS_MANAGE: 'blogs.manage',
  BLOG_CATEGORIES_MANAGE: 'blog-categories.manage',
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
] as const;

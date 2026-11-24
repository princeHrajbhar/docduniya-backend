import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { initializeFoundation, seedStarterSpecialties, foundationModels } from './foundation.js';
import { ensureSystemRoles } from '../modules/admin/auth/roles/role.service.js';
import { upgradeProviderPermissions } from './provider-permissions.js';
import { upgradeBuiltInRoles } from '../modules/access/role-assignment.service.js';
import { seedNotificationTemplates } from '../modules/notifications/notification.service.js';

try {
  await mongoose.connect(env.MONGO_URI, {
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 15_000,
  });
  await initializeFoundation();
  await upgradeProviderPermissions();
  await ensureSystemRoles();
  await seedStarterSpecialties();
  const upgradedRoles = await upgradeBuiltInRoles();
  await seedNotificationTemplates();
  process.stdout.write(
    `Initialized ${foundationModels.length} collections with indexes; applied ${upgradedRoles} built-in role upgrades.\n`,
  );
} catch (error) {
  process.stderr.write(
    `Foundation setup failed: ${error instanceof Error ? error.name : 'Unknown error'}. Check replica-set readiness, index conflicts and database permissions.\n`,
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

/**
 * Creates or resets the Super Admin account.
 *
 *   ADMIN_EMAIL=owner@example.com ADMIN_PASSWORD='Str0ng!Pass' npm run admin:create
 */
import { connectDB, disconnectDB } from '../../../../config/db.js';
import { logger } from '../../../../config/logger.js';
import { SUPER_ADMIN_ROLE } from '../auth.constants.js';
import { hashPassword } from '../auth.crypto.js';
import { emailSchema, passwordSchema } from '../auth.validation.js';
import { User } from '../models/user.model.js';
import { clearSecrets } from '../otp.service.js';
import { ensureSystemRoles } from '../roles/role.service.js';
import { revokeAllSessions } from '../session.service.js';

async function main(): Promise<void> {
  const email = emailSchema.parse(process.env.ADMIN_EMAIL ?? '');
  const passwordResult = passwordSchema.safeParse(process.env.ADMIN_PASSWORD ?? '');
  if (!passwordResult.success) {
    throw new Error(
      'ADMIN_PASSWORD must be 8-128 characters and include uppercase, lowercase, number and special character',
    );
  }

  await connectDB();
  await ensureSystemRoles();

  const admin = await User.findOneAndUpdate(
    { email },
    {
      $set: {
        email,
        password: await hashPassword(passwordResult.data),
        role: SUPER_ADMIN_ROLE,
        isVerified: true,
        isActive: true,
        mustChangePassword: false,
        failedLoginAttempts: 0,
      },
      $unset: { lockedUntil: 1, lastFailedLoginAt: 1 },
    },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true, runValidators: true },
  );

  await Promise.all([revokeAllSessions(admin._id), clearSecrets(email)]);
  logger.info({ userId: admin._id, email }, 'Super Admin account created or updated');
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'Super Admin bootstrap failed');
    process.exitCode = 1;
  })
  .finally(() => disconnectDB().catch(() => undefined));

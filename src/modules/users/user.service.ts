import crypto from 'node:crypto';
import type { QueryFilter } from 'mongoose';
import { logger } from '../../config/logger.js';
import { AppError, ErrorCode } from '../../utils/app-error.js';
import { escapeRegExp, isDuplicateKeyError } from '../../utils/mongo.js';
import {
  SUPER_ADMIN_ROLE,
  User,
  clearSecrets,
  hashPassword,
  listActiveSessions,
  revokeAllSessions,
  revokeSession,
  roleExists,
  sendAccountSetupLink,
  type IUser,
  type UserDocument,
} from '../admin/auth/index.js';
import { managedFileService } from '../managed-files/index.js';
import { sendAccountUpdatedEmail } from './user.emails.js';
import type { CreateUserInput, UpdateUserInput, UserQueryInput } from './user.validation.js';

/** Fields that are never returned by the admin API. */
const HIDDEN_FIELDS = '-password -googleSub';
const MAX_EXPORT_ROWS = 50_000;

export class UserService {
  async createUser(data: CreateUserInput, actorUserId: string) {
    await assertRoleAssignmentAllowed(data.role, actorUserId);
    if (await User.exists({ email: data.email })) {
      throw new AppError('User with this email already exists', 409, ErrorCode.USER_EXISTS);
    }

    let user: UserDocument;
    try {
      user = await User.create({
        email: data.email,
        // Without an initial password the account is unusable until the setup link is completed.
        password: await hashPassword(data.password ?? crypto.randomBytes(32).toString('hex')),
        role: data.role,
        isVerified: true,
        mustChangePassword: true,
        failedLoginAttempts: 0,
      });
    } catch (error) {
      if (isDuplicateKeyError(error))
        throw new AppError('User with this email already exists', 409, ErrorCode.USER_EXISTS);
      throw error;
    }

    await clearSecrets(data.email);
    const onboardingEmailSent = await sendAccountSetupLink({
      email: data.email,
      role: data.role,
      actorUserId,
    });

    logger.info(
      { actorUserId, userId: user._id, role: user.role, onboardingEmailSent },
      'User created by admin',
    );
    return { ...toAdminUser(user.toObject()), onboardingEmailSent };
  }

  async getUsers(query: UserQueryInput) {
    const { page, limit } = query;
    const filter = buildFilter(query);

    const [users, total] = await Promise.all([
      User.find(filter)
        .select(HIDDEN_FIELDS)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    return {
      users: users.map(toAdminUser),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  getUsersForExport(query: UserQueryInput) {
    return User.find(buildFilter(query))
      .select(HIDDEN_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .limit(MAX_EXPORT_ROWS)
      .lean();
  }

  async getUserById(id: string) {
    const user = await User.findById(id).select(HIDDEN_FIELDS).lean();
    if (!user) throw new AppError('User not found', 404, ErrorCode.USER_NOT_FOUND);
    return toAdminUser(user);
  }

  async updateUser(id: string, data: UpdateUserInput, actorUserId: string) {
    const current = await User.findById(id);
    if (!current) throw new AppError('User not found', 404, ErrorCode.USER_NOT_FOUND);

    assertSafeSelfUpdate(current._id.toString(), actorUserId, current.role, data);
    if (data.role !== undefined) await assertRoleAssignmentAllowed(data.role, actorUserId);
    await assertLastSuperAdminIsPreserved(current, data);

    const emailChanged = data.email !== undefined && data.email !== current.email;
    if (emailChanged && (await User.exists({ email: data.email, _id: { $ne: current._id } }))) {
      throw new AppError('Email already in use', 409, ErrorCode.USER_EXISTS);
    }

    const updateData: Partial<IUser> = {};
    if (data.email !== undefined) updateData.email = data.email;
    if (data.role !== undefined) updateData.role = data.role;
    if (data.isVerified !== undefined) updateData.isVerified = data.isVerified;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.password !== undefined) {
      updateData.password = await hashPassword(data.password);
      updateData.mustChangePassword = true;
      updateData.failedLoginAttempts = 0;
    }

    let user;
    try {
      user = await User.findByIdAndUpdate(
        id,
        {
          $set: updateData,
          ...(data.password !== undefined
            ? { $unset: { lockedUntil: 1, lastFailedLoginAt: 1 } }
            : {}),
        },
        { returnDocument: 'after', runValidators: true },
      )
        .select(HIDDEN_FIELDS)
        .lean();
    } catch (error) {
      if (isDuplicateKeyError(error))
        throw new AppError('Email already in use', 409, ErrorCode.USER_EXISTS);
      throw error;
    }
    if (!user) throw new AppError('User not found', 404, ErrorCode.USER_NOT_FOUND);

    const shouldRevokeSessions =
      data.password !== undefined ||
      emailChanged ||
      (data.role !== undefined && data.role !== current.role) ||
      data.isVerified === false ||
      data.isActive === false;

    await Promise.all([
      shouldRevokeSessions ? revokeAllSessions(current._id) : undefined,
      emailChanged
        ? clearSecrets([current.email, user.email])
        : data.isVerified === true
          ? clearSecrets(current.email, ['EMAIL_VERIFICATION'])
          : undefined,
    ]);

    // Notify the account (and the previous address when the email changed).
    const changedFields = Object.keys(data);
    const recipients = [...new Set([user.email, ...(emailChanged ? [current.email] : [])])];
    let notificationEmailsSent = 0;
    for (const recipient of recipients) {
      try {
        await sendAccountUpdatedEmail({
          to: recipient,
          email: user.email,
          previousEmail: emailChanged ? current.email : undefined,
          role: user.role,
          changedFields,
          passwordChanged: data.password !== undefined,
          actorUserId,
        });
        notificationEmailsSent += 1;
      } catch (error) {
        logger.error(
          { err: error, actorUserId, userId: current._id },
          'Account notification email could not be sent',
        );
      }
    }

    logger.info(
      { actorUserId, userId: current._id, fields: changedFields, notificationEmailsSent },
      'User updated by admin',
    );
    return {
      ...toAdminUser(user),
      notificationEmailSent: notificationEmailsSent === recipients.length,
      notificationEmailsSent,
    };
  }

  async deleteUser(id: string, actorUserId: string) {
    if (id === actorUserId) {
      throw new AppError('You cannot delete your own account', 400, ErrorCode.BAD_REQUEST);
    }

    const user = await User.findById(id);
    if (!user) throw new AppError('User not found', 404, ErrorCode.USER_NOT_FOUND);
    await assertLastSuperAdminIsPreserved(user, { role: 'user' });

    const deleted = await User.deleteOne({ _id: user._id });
    if (deleted.deletedCount !== 1)
      throw new AppError('User not found', 404, ErrorCode.USER_NOT_FOUND);

    const [, , removedFiles] = await Promise.all([
      revokeAllSessions(user._id),
      clearSecrets(user.email),
      managedFileService.removeAllForOwner(user._id),
    ]);

    logger.info(
      { actorUserId, userId: user._id, removedFiles },
      'User and owned files deleted by admin',
    );
    return { message: 'User deleted successfully', id };
  }

  async setVerification(id: string, isVerified: boolean, actorUserId: string) {
    if (id === actorUserId && !isVerified) {
      throw new AppError('You cannot unverify your own account', 400, ErrorCode.BAD_REQUEST);
    }

    const user = await User.findById(id);
    if (!user) throw new AppError('User not found', 404, ErrorCode.USER_NOT_FOUND);
    await assertLastSuperAdminIsPreserved(user, { isVerified });

    user.isVerified = isVerified;
    await user.save();

    if (isVerified) await clearSecrets(user.email, ['EMAIL_VERIFICATION']);
    else await revokeAllSessions(user._id);

    logger.info(
      { actorUserId, userId: user._id, isVerified },
      'User verification changed by admin',
    );
    return toAdminUser(user.toObject());
  }

  async getUserSessions(id: string) {
    await this.getUserById(id);
    return listActiveSessions(id);
  }

  async revokeUserSession(id: string, sessionId: string, actorUserId: string) {
    await this.getUserById(id);
    if (!(await revokeSession(id, sessionId))) {
      throw new AppError('Session not found', 404, ErrorCode.SESSION_NOT_FOUND);
    }
    logger.info({ actorUserId, userId: id, sessionId }, 'User session revoked by admin');
    return { id: sessionId };
  }

  async revokeAllUserSessions(id: string, actorUserId: string) {
    await this.getUserById(id);
    const revokedCount = await revokeAllSessions(id);
    logger.info({ actorUserId, userId: id, revokedCount }, 'All user sessions revoked by admin');
    return { revokedCount };
  }

  async getLockStatus(email: string) {
    const user = await User.findOne({ email })
      .select('email failedLoginAttempts lockedUntil lastFailedLoginAt')
      .lean();
    if (!user) throw new AppError('User not found', 404, ErrorCode.USER_NOT_FOUND);

    const isLocked = Boolean(user.lockedUntil && user.lockedUntil > new Date());
    return {
      email: user.email,
      isLocked,
      lockedUntil: isLocked ? user.lockedUntil : null,
      failedLoginAttempts: user.failedLoginAttempts,
      lastFailedLoginAt: user.lastFailedLoginAt ?? null,
    };
  }

  async unlockUser(id: string, actorUserId: string) {
    const user = await User.findByIdAndUpdate(
      id,
      { $set: { failedLoginAttempts: 0 }, $unset: { lockedUntil: 1, lastFailedLoginAt: 1 } },
      { returnDocument: 'after', runValidators: true },
    )
      .select(HIDDEN_FIELDS)
      .lean();
    if (!user) throw new AppError('User not found', 404, ErrorCode.USER_NOT_FOUND);

    logger.info({ actorUserId, userId: id }, 'User unlocked by admin');
    return toAdminUser(user);
  }
}

export const userService = new UserService();

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildFilter(query: UserQueryInput): QueryFilter<IUser> {
  const filter: QueryFilter<IUser> = {};
  if (query.role !== undefined) filter.role = query.role;
  if (query.isVerified !== undefined) filter.isVerified = query.isVerified;
  if (query.isActive !== undefined) filter.isActive = query.isActive;
  if (query.search) filter.email = { $regex: escapeRegExp(query.search), $options: 'i' };
  return filter;
}

function toAdminUser<T extends { _id: unknown; password?: unknown; googleSub?: unknown }>(user: T) {
  const safe: Omit<T, 'password' | 'googleSub'> & { password?: unknown; googleSub?: unknown } = {
    ...user,
  };
  delete safe.password;
  delete safe.googleSub;
  return { ...(safe as Omit<T, 'password' | 'googleSub'>), id: String(user._id) };
}

function assertSafeSelfUpdate(
  targetUserId: string,
  actorUserId: string,
  currentRole: string,
  data: UpdateUserInput,
) {
  if (targetUserId !== actorUserId) return;
  if (
    currentRole === SUPER_ADMIN_ROLE &&
    data.role !== undefined &&
    data.role !== SUPER_ADMIN_ROLE
  ) {
    throw new AppError('You cannot remove your own Super Admin role', 400, ErrorCode.BAD_REQUEST);
  }
  if (data.isVerified === false)
    throw new AppError('You cannot unverify your own account', 400, ErrorCode.BAD_REQUEST);
  if (data.isActive === false)
    throw new AppError('You cannot disable your own account', 400, ErrorCode.BAD_REQUEST);
}

async function assertRoleAssignmentAllowed(role: string, actorUserId: string): Promise<void> {
  if (!(await roleExists(role))) {
    throw new AppError(
      'Selected role does not exist or is not assignable',
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }
  if (role !== SUPER_ADMIN_ROLE) return;
  const actor = await User.findById(actorUserId).select('role').lean();
  if (actor?.role !== SUPER_ADMIN_ROLE) {
    throw new AppError(
      'Only a Super Admin can assign the Super Admin role',
      403,
      ErrorCode.FORBIDDEN,
    );
  }
}

/** Prevents removing, unverifying or disabling the last active Super Admin. */
async function assertLastSuperAdminIsPreserved(
  current: Pick<IUser, 'role' | 'isVerified' | 'isActive'>,
  changes: Partial<Pick<UpdateUserInput, 'role' | 'isVerified' | 'isActive'>>,
): Promise<void> {
  const isOwner = (role: string, verified: boolean, active: boolean) =>
    role === SUPER_ADMIN_ROLE && verified && active;
  const currentlyOwner = isOwner(current.role, current.isVerified, current.isActive);
  const remainsOwner = isOwner(
    changes.role ?? current.role,
    changes.isVerified ?? current.isVerified,
    changes.isActive ?? current.isActive,
  );
  if (!currentlyOwner || remainsOwner) return;

  const activeOwners = await User.countDocuments({
    role: SUPER_ADMIN_ROLE,
    isVerified: true,
    isActive: true,
  });
  if (activeOwners <= 1) {
    throw new AppError(
      'At least one active, verified Super Admin account must remain',
      400,
      ErrorCode.BAD_REQUEST,
    );
  }
}

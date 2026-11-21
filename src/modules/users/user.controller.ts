import type { Request, Response } from 'express';
import { createXlsxWorkbook } from '../../utils/xlsx.js';
import {
  blockEmail,
  EMAIL_DELIVERY_HINT,
  getEmailPreference,
  unblockEmail,
} from '../email/index.js';
import { userService } from './user.service.js';
import type { CreateUserInput, UpdateUserInput, UserQueryInput } from './user.validation.js';

type IdRequest = Request<{ id: string }>;

export async function createUser(req: Request, res: Response) {
  const user = await userService.createUser(req.body as CreateUserInput, req.user!.userId);
  res.status(201).json({
    success: true,
    data: user,
    message: user.onboardingEmailSent
      ? `User created and a secure password-setup link was sent by email. ${EMAIL_DELIVERY_HINT}`
      : 'User created, but the onboarding email could not be sent. Check the email configuration.',
  });
}

export async function getUsers(req: Request, res: Response) {
  const result = await userService.getUsers(req.query as unknown as UserQueryInput);
  res.json({ success: true, data: result.users, pagination: result.pagination });
}

export async function exportUsers(req: Request, res: Response) {
  const users = await userService.getUsersForExport(req.query as unknown as UserQueryInput);
  const workbook = createXlsxWorkbook(
    'Users',
    [
      'Email',
      'Role',
      'Verified',
      'Active',
      'Password change required',
      'Failed login attempts',
      'Locked until',
      'Last login',
      'Created at',
      'Updated at',
    ],
    users.map((user) => [
      user.email,
      user.role,
      user.isVerified,
      user.isActive,
      user.mustChangePassword,
      user.failedLoginAttempts,
      user.lockedUntil,
      user.lastLoginAt,
      user.createdAt,
      user.updatedAt,
    ]),
  );
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.xlsx"`,
  );
  res.status(200).send(workbook);
}

export async function getUserById(req: IdRequest, res: Response) {
  res.json({ success: true, data: await userService.getUserById(req.params.id) });
}

export async function updateUser(req: IdRequest, res: Response) {
  const user = await userService.updateUser(
    req.params.id,
    req.body as UpdateUserInput,
    req.user!.userId,
  );
  res.json({
    success: true,
    data: user,
    message: user.notificationEmailSent
      ? `User updated and the account notification was sent by email. ${EMAIL_DELIVERY_HINT}`
      : 'User updated, but the notification email could not be sent.',
  });
}

export async function deleteUser(req: IdRequest, res: Response) {
  const result = await userService.deleteUser(req.params.id, req.user!.userId);
  res.json({ success: true, message: result.message, data: { id: result.id } });
}

export async function setVerification(req: IdRequest, res: Response) {
  const { isVerified } = req.body as { isVerified: boolean };
  const user = await userService.setVerification(req.params.id, isVerified, req.user!.userId);
  res.json({ success: true, data: user, message: `User verification set to ${user.isVerified}` });
}

export async function getUserSessions(req: IdRequest, res: Response) {
  res.json({ success: true, data: await userService.getUserSessions(req.params.id) });
}

export async function revokeUserSession(
  req: Request<{ id: string; sessionId: string }>,
  res: Response,
) {
  const data = await userService.revokeUserSession(
    req.params.id,
    req.params.sessionId,
    req.user!.userId,
  );
  res.json({ success: true, data, message: 'Session revoked successfully' });
}

export async function revokeAllUserSessions(req: IdRequest, res: Response) {
  const data = await userService.revokeAllUserSessions(req.params.id, req.user!.userId);
  res.json({ success: true, data, message: `${data.revokedCount} session(s) revoked` });
}

export async function checkLockStatus(req: Request<{ email: string }>, res: Response) {
  res.json({ success: true, data: await userService.getLockStatus(req.params.email) });
}

export async function unlockUser(req: IdRequest, res: Response) {
  const user = await userService.unlockUser(req.params.id, req.user!.userId);
  res.json({ success: true, data: user, message: 'User unlocked successfully' });
}

export async function getUserEmailPreference(req: IdRequest, res: Response) {
  const user = await userService.getUserById(req.params.id);
  res.json({ success: true, data: await getEmailPreference(user.email) });
}

export async function setUserEmailPreference(req: IdRequest, res: Response) {
  const user = await userService.getUserById(req.params.id);
  const { blocked, reason } = req.body as { blocked: boolean; reason?: string };
  const data = blocked
    ? await blockEmail(user.email, reason, req.user!.userId)
    : await unblockEmail(user.email);
  res.json({
    success: true,
    message: blocked
      ? 'Email blocked. No future communication will be sent to this address.'
      : 'Email unblocked',
    data,
  });
}

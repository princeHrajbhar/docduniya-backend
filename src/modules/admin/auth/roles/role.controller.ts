import type { Request, Response } from 'express';
import { ALL_PERMISSIONS, PERMISSION_GROUPS } from './permission.constants.js';
import { roleService } from './role.service.js';
import type { CreateRoleInput, UpdateRoleInput } from './role.validation.js';

// Express 5 forwards rejected promises to the error handler, so no try/catch is needed.

export async function listAssignableRoles(_req: Request, res: Response) {
  res.json({ success: true, data: await roleService.listAssignable() });
}

export async function listRoles(_req: Request, res: Response) {
  res.json({ success: true, data: await roleService.list(), permissions: PERMISSION_GROUPS });
}

export function getPermissionCatalog(_req: Request, res: Response) {
  res.json({ success: true, data: PERMISSION_GROUPS, keys: ALL_PERMISSIONS });
}

export async function createRole(req: Request, res: Response) {
  const role = await roleService.create(req.body as CreateRoleInput);
  res.status(201).json({ success: true, message: 'Role created', data: role });
}

export async function updateRole(req: Request<{ id: string }>, res: Response) {
  const role = await roleService.update(req.params.id, req.body as UpdateRoleInput);
  res.json({ success: true, message: 'Role updated', data: role });
}

export async function deleteRole(req: Request<{ id: string }>, res: Response) {
  await roleService.remove(req.params.id);
  res.json({ success: true, message: 'Role deleted' });
}

import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '../../utils/app-error.js';
import { PERMISSIONS, hasPermission } from '../admin/auth/index.js';
import { managedFileService as service } from './managed-file.service.js';
import type {
  ManagedFileListQuery,
  UpdateManagedFileSeoInput,
  UploadManagedFileInput,
} from './managed-file.validation.js';

type IdRequest = Request<{ id: string }>;

function uploadedFile(req: Request): Express.Multer.File {
  const files = Array.isArray(req.files) ? req.files : req.files?.file;
  const file = Array.isArray(files) ? files[0] : undefined;
  if (!file) throw new AppError('File is required', 400, ErrorCode.BAD_REQUEST);
  return file;
}

const canManageFiles = (req: Request) => hasPermission(req, PERMISSIONS.FILES_MANAGE);

async function sendList(req: Request, res: Response, isAdmin: boolean) {
  const query = req.query as unknown as ManagedFileListQuery;
  const { files, total } = await service.list(query, req.user!.userId, isAdmin);
  res.json({
    success: true,
    data: await Promise.all(files.map((file) => service.present(file))),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  });
}

export async function upload(req: Request, res: Response) {
  const file = await service.upload(
    uploadedFile(req),
    req.body as UploadManagedFileInput,
    req.user!.userId,
    canManageFiles(req),
  );
  res.status(201).json({
    success: true,
    message: 'File uploaded successfully',
    data: await service.present(file),
  });
}

export const listMine = (req: Request, res: Response) => sendList(req, res, false);

export const listAll = (req: Request, res: Response) => sendList(req, res, true);

export async function getFile(req: IdRequest, res: Response) {
  const file = await service.get(req.params.id, req.user!.userId, canManageFiles(req));
  res.json({ success: true, data: await service.present(file) });
}

export async function deleteFile(req: IdRequest, res: Response) {
  await service.remove(req.params.id, req.user!.userId, canManageFiles(req));
  res.json({ success: true, message: 'File deleted successfully' });
}

export async function updateSeo(req: IdRequest, res: Response) {
  const file = await service.updateSeo(
    req.params.id,
    req.body as UpdateManagedFileSeoInput,
    req.user!.userId,
  );
  res.json({
    success: true,
    message: 'File SEO metadata updated successfully',
    data: await service.present(file),
  });
}

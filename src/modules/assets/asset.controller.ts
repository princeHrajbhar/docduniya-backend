import type { Request, Response } from 'express';

import { assetService } from './asset.service.js';
import {
  assetIdParamSchema,
  assetSlugParamSchema,
  bulkDeleteAssetsSchema,
  createAssetSchema,
  listAssetsQuerySchema,
  updateAssetSchema,
} from './asset.validation.js';

// Express 5 forwards rejected promises to the error middleware,
// so handlers don't need try/catch.

export async function createAsset(req: Request, res: Response) {
  const input = createAssetSchema.parse(req.body);

  const asset = await assetService.createAsset(req.file, input);

  return res.status(201).json({
    success: true,
    message: 'Asset created successfully',
    data: asset,
  });
}

export async function listAssets(req: Request, res: Response) {
  const query = listAssetsQuerySchema.parse(req.query);

  const { items, pagination } = await assetService.listAssets(query);

  return res.status(200).json({
    success: true,
    data: items,
    pagination,
  });
}

export async function getAssetById(req: Request, res: Response) {
  const { id } = assetIdParamSchema.parse(req.params);

  const asset = await assetService.getAssetById(id);

  return res.status(200).json({ success: true, data: asset });
}

export async function getAssetBySlug(req: Request, res: Response) {
  const { slug } = assetSlugParamSchema.parse(req.params);

  const asset = await assetService.getAssetBySlug(slug);

  return res.status(200).json({ success: true, data: asset });
}

export async function updateAsset(req: Request, res: Response) {
  const { id } = assetIdParamSchema.parse(req.params);
  const input = updateAssetSchema.parse(req.body);

  const asset = await assetService.updateAsset(id, input);

  return res.status(200).json({
    success: true,
    message: 'Asset updated successfully',
    data: asset,
  });
}

export async function replaceAssetFile(req: Request, res: Response) {
  const { id } = assetIdParamSchema.parse(req.params);

  const asset = await assetService.replaceAssetFile(id, req.file);

  return res.status(200).json({
    success: true,
    message: 'Asset file replaced successfully',
    data: asset,
  });
}

export async function deleteAsset(req: Request, res: Response) {
  const { id } = assetIdParamSchema.parse(req.params);

  const result = await assetService.deleteAsset(id);

  return res.status(200).json({
    success: true,
    message: 'Asset deleted successfully',
    data: result,
  });
}

export async function deleteAssets(req: Request, res: Response) {
  const { ids } = bulkDeleteAssetsSchema.parse(req.body);

  const result = await assetService.deleteAssets(ids);

  return res.status(200).json({
    success: true,
    message: `${result.deleted.length} assets deleted`,
    data: result,
  });
}

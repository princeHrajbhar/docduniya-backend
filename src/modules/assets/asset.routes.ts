import { Router } from 'express';
import { uploadLimiter } from '../../middlewares/rate-limit.js';
import { PERMISSIONS, protect, requirePermission } from '../admin/auth/index.js';
import {
  createAsset,
  deleteAsset,
  deleteAssets,
  getAssetById,
  getAssetBySlug,
  listAssets,
  replaceAssetFile,
  updateAsset,
} from './asset.controller.js';
import { assetUpload } from './asset.upload.js';

const router = Router();

// The media library is an admin feature; controllers validate their own input.
router.use(protect, requirePermission(PERMISSIONS.ASSETS_MANAGE));

router.post('/', uploadLimiter, assetUpload.single('file'), createAsset);
router.get('/', listAssets);

// Static paths must be registered before "/:id".
router.get('/slug/:slug', getAssetBySlug);
router.delete('/bulk', deleteAssets);

router.get('/:id', getAssetById);
router.patch('/:id', updateAsset);
router.put('/:id/file', uploadLimiter, assetUpload.single('file'), replaceAssetFile);
router.delete('/:id', deleteAsset);

export default router;

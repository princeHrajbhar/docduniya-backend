import type { QueryFilter, Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { AppError, ErrorCode } from '../../utils/app-error.js';
import { escapeRegExp } from '../../utils/mongo.js';
import { User } from '../admin/auth/index.js';
import { deleteAsset, deleteAssets, getAssetUrl, uploadAsset } from '../file-manager/index.js';
import { ManagedFile, type IManagedFile, type ManagedFileDocument } from './managed-file.model.js';
import type {
  ManagedFileListQuery,
  UpdateManagedFileSeoInput,
  UploadManagedFileInput,
} from './managed-file.validation.js';

const OWNER_FIELDS = 'email role';

export class ManagedFileService {
  async upload(
    file: Express.Multer.File,
    body: UploadManagedFileInput,
    actorUserId: string,
    isAdmin: boolean,
  ) {
    // Only file managers may upload for someone else or pick an explicit folder.
    const ownerId = isAdmin && body.ownerId ? body.ownerId : actorUserId;
    if (!(await User.exists({ _id: ownerId }))) {
      throw new AppError('File owner not found', 404, ErrorCode.USER_NOT_FOUND);
    }

    const seoMetadata: Record<string, string> = {
      ...(body.metadata ?? {}),
      ...(body.title ? { title: body.title } : {}),
      ...(body.description ? { description: body.description } : {}),
      ...(body.altText ? { altText: body.altText } : {}),
      ...(body.caption ? { caption: body.caption } : {}),
    };

    const asset = await uploadAsset({
      file,
      folder: (isAdmin && body.folder) || `managed/${ownerId}/${body.category}`,
      ...(body.visibility ? { visibility: body.visibility } : {}),
      filename: body.filename || body.title || body.altText || body.label || file.originalname,
      ...(body.optimizeImage === 'false' ? { imageOptimization: false as const } : {}),
      metadata: seoMetadata,
    });

    try {
      return await ManagedFile.create({
        ownerId,
        createdBy: actorUserId,
        category: body.category,
        label: body.label,
        asset,
        metadata: seoMetadata,
      });
    } catch (error) {
      // Never leave an orphaned object in storage when the record cannot be saved.
      await deleteAsset(asset).catch(() => undefined);
      throw error;
    }
  }

  async list(query: ManagedFileListQuery, actorUserId: string, isAdmin: boolean) {
    const filter: QueryFilter<IManagedFile> = isAdmin ? {} : { ownerId: actorUserId };
    if (isAdmin && query.ownerId) filter.ownerId = query.ownerId;
    if (query.category) filter.category = query.category.toLowerCase();
    if (query.search) {
      const search = new RegExp(escapeRegExp(query.search), 'i');
      filter.$or = [
        { label: search },
        { 'asset.originalName': search },
        { 'asset.storageKey': search },
      ];
    }

    const [files, total] = await Promise.all([
      ManagedFile.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .populate('ownerId', OWNER_FIELDS)
        .populate('createdBy', OWNER_FIELDS)
        .exec(),
      ManagedFile.countDocuments(filter),
    ]);
    return { files, total };
  }

  async get(id: string, actorUserId: string, isAdmin: boolean): Promise<ManagedFileDocument> {
    const file = await ManagedFile.findById(id)
      .populate('ownerId', OWNER_FIELDS)
      .populate('createdBy', OWNER_FIELDS)
      .exec();
    if (!file) throw new AppError('File not found', 404, ErrorCode.NOT_FOUND);

    const owner = file.ownerId as unknown as { _id?: Types.ObjectId } | Types.ObjectId;
    const ownerId = String('_id' in owner && owner._id ? owner._id : owner);
    if (!isAdmin && ownerId !== actorUserId) {
      throw new AppError('Insufficient permissions', 403, ErrorCode.FORBIDDEN);
    }
    return file;
  }

  async remove(id: string, actorUserId: string, isAdmin: boolean): Promise<void> {
    const file = await this.get(id, actorUserId, isAdmin);
    // Storage first: if the provider fails, the record survives and the delete can be retried.
    await deleteAsset(file.asset);
    await ManagedFile.deleteOne({ _id: file._id });
  }

  async updateSeo(id: string, body: UpdateManagedFileSeoInput, actorUserId: string) {
    const file = await this.get(id, actorUserId, true);
    if (body.label !== undefined) file.label = body.label;
    if (body.title !== undefined) file.asset.title = body.title;
    if (body.description !== undefined) file.asset.description = body.description;
    if (body.altText !== undefined) file.asset.altText = body.altText;
    if (body.caption !== undefined) file.asset.caption = body.caption;

    for (const key of ['title', 'description', 'altText', 'caption'] as const) {
      const value = body[key];
      if (value !== undefined) file.metadata.set(key, value);
    }

    await file.save();
    return file;
  }

  /** Removes every file owned by a user (used when the account is deleted). */
  async removeAllForOwner(ownerId: string | Types.ObjectId): Promise<number> {
    const files = await ManagedFile.find({ ownerId }).select('asset').lean();
    if (!files.length) return 0;
    await deleteAssets(files.map((file) => file.asset)).catch((error: unknown) =>
      logger.error({ err: error, ownerId }, 'One or more stored objects could not be removed'),
    );
    await ManagedFile.deleteMany({ ownerId });
    return files.length;
  }

  async present(file: ManagedFileDocument) {
    const plain = file.toObject({ flattenMaps: true });
    return {
      ...plain,
      id: String(file._id),
      asset: {
        ...plain.asset,
        url: await getAssetUrl(plain.asset, {
          expiresInSeconds: 900,
          filename: plain.asset.originalName,
        }),
      },
    };
  }
}

export const managedFileService = new ManagedFileService();

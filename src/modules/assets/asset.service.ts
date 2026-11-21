import type { QueryFilter } from 'mongoose';

import { logger } from '../../config/logger.js';

import { AssetStorageError } from './storage/storage.error.js';
import { storageService } from './storage/storage.service.js';

import { AssetModel } from './asset.model.js';
import { AssetError } from './asset.error.js';
import {
  buildFileFields,
  buildFileName,
  escapeRegex,
  extractImageDimensions,
  folderToStoragePath,
  getBaseName,
  isDuplicateKeyError,
  resolveAssetType,
  resolveSlug,
} from './asset.utils.js';
import type {
  Asset,
  AssetDocument,
  BulkDeleteAssetsResult,
  CreateAssetInput,
  ListAssetsQuery,
  PaginatedAssets,
  UpdateAssetInput,
} from './asset.types.js';

class AssetService {
  async createAsset(
    file: Express.Multer.File | undefined,
    input: CreateAssetInput,
  ): Promise<AssetDocument> {
    if (!file) {
      throw AssetError.fileRequired();
    }

    const assetType = resolveAssetType(file.mimetype);

    if (assetType === 'image' && !input.alt) {
      throw AssetError.altRequired();
    }

    const slug = resolveSlug(input.slug ?? input.title ?? getBaseName(file.originalname));

    await this.assertSlugAvailable(slug);

    const dimensions = await extractImageDimensions(file.buffer, file.mimetype);

    const stored = await storageService.uploadFile({
      file,
      seoName: slug,
      path: {
        module: input.module,
        entity: input.entity,
        category: input.category,
      },
    });

    try {
      const fileFields = buildFileFields(stored, slug, assetType, dimensions);

      const asset = await AssetModel.create({
        ...fileFields,
        slug,
        alt: input.alt ?? '',
        title: input.title ?? getBaseName(file.originalname),
        caption: input.caption ?? '',
        description: input.description ?? '',
        seoTitle: input.seoTitle ?? '',
        seoDescription: input.seoDescription ?? '',
        keywords: input.keywords ?? [],
        tags: input.tags ?? [],
        indexable: input.indexable ?? true,
        searchable: input.searchable ?? true,
        visibility: input.visibility ?? 'public',
        status: input.status ?? 'active',
      });

      return asset.toObject();
    } catch (error) {
      await this.discardStoredFile(stored);

      if (isDuplicateKeyError(error)) {
        throw AssetError.slugConflict(slug);
      }

      throw error;
    }
  }

  async listAssets(query: ListAssetsQuery): Promise<PaginatedAssets> {
    const { page, limit, sortBy, sortOrder } = query;

    const filter = this.buildListFilter(query);

    const [items, total] = await Promise.all([
      AssetModel.find(filter)
        .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<AssetDocument[]>(),
      AssetModel.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  async getAssetById(id: string): Promise<AssetDocument> {
    const asset = await AssetModel.findById(id).lean<AssetDocument>();

    if (!asset) {
      throw AssetError.notFound(id);
    }

    return asset;
  }

  async getAssetBySlug(slug: string): Promise<AssetDocument> {
    const asset = await AssetModel.findOne({
      slug: slug.toLowerCase(),
    }).lean<AssetDocument>();

    if (!asset) {
      throw AssetError.notFound(slug);
    }

    return asset;
  }

  /**
   * Metadata-only update. The stored object (key, url, size...) is never
   * touched here; use replaceAssetFile to change the file itself.
   */
  async updateAsset(id: string, input: UpdateAssetInput): Promise<AssetDocument> {
    const existing = await this.getAssetById(id);

    const changes: Partial<Asset> = { ...input };

    if (input.slug !== undefined) {
      const slug = resolveSlug(input.slug);

      if (slug !== existing.slug) {
        await this.assertSlugAvailable(slug, id);
      }

      changes.slug = slug;
      changes.fileName = buildFileName(slug, existing.extension);
    }

    if (existing.assetType === 'image' && input.alt !== undefined && !input.alt) {
      throw AssetError.altRequired();
    }

    try {
      const updated = await AssetModel.findByIdAndUpdate(
        id,
        { $set: changes },
        { new: true, runValidators: true },
      ).lean<AssetDocument>();

      if (!updated) {
        throw AssetError.notFound(id);
      }

      return updated;
    } catch (error) {
      if (isDuplicateKeyError(error) && changes.slug) {
        throw AssetError.slugConflict(changes.slug);
      }

      throw error;
    }
  }

  /**
   * Swaps the underlying file while keeping the asset's id, slug and
   * descriptive metadata. New object is uploaded first; the old one is
   * removed only after the database points at the new one.
   */
  async replaceAssetFile(
    id: string,
    file: Express.Multer.File | undefined,
  ): Promise<AssetDocument> {
    if (!file) {
      throw AssetError.fileRequired();
    }

    const existing = await this.getAssetById(id);

    const assetType = resolveAssetType(file.mimetype);

    if (assetType !== existing.assetType) {
      throw AssetError.typeMismatch(existing.assetType, assetType);
    }

    const dimensions = await extractImageDimensions(file.buffer, file.mimetype);

    const stored = await storageService.uploadFile({
      file,
      seoName: existing.slug,
      path: folderToStoragePath(existing.folder),
    });

    let updated: AssetDocument | null;

    try {
      updated = await AssetModel.findByIdAndUpdate(
        id,
        {
          $set: buildFileFields(stored, existing.slug, assetType, dimensions),
        },
        { new: true, runValidators: true },
      ).lean<AssetDocument>();
    } catch (error) {
      await this.discardStoredFile(stored);
      throw error;
    }

    if (!updated) {
      // Asset was deleted while the new file was uploading.
      await this.discardStoredFile(stored);
      throw AssetError.notFound(id);
    }

    await this.discardStoredFile(existing);

    return updated;
  }

  async deleteAsset(id: string): Promise<{ id: string; deleted: true }> {
    const asset = await this.getAssetById(id);

    // Storage first: if the provider fails the record survives and can be
    // retried. Deleting a missing object is a no-op, so retries are safe.
    await storageService.deleteFile(asset.key, asset.provider);
    await AssetModel.deleteOne({ _id: asset._id });

    return { id, deleted: true };
  }

  async deleteAssets(ids: string[]): Promise<BulkDeleteAssetsResult> {
    const assets = await AssetModel.find({ _id: { $in: ids } })
      .select('_id key provider')
      .lean<Array<Pick<AssetDocument, '_id' | 'key' | 'provider'>>>();

    const foundIds = new Set(assets.map((asset) => String(asset._id)));
    const notFound = ids.filter((id) => !foundIds.has(id));

    // Assets may live on different providers after a migration.
    const byProvider = new Map<string, typeof assets>();

    for (const asset of assets) {
      byProvider.set(asset.provider, [...(byProvider.get(asset.provider) ?? []), asset]);
    }

    const deletedIds: string[] = [];
    const failed: BulkDeleteAssetsResult['failed'] = [];

    for (const [provider, group] of byProvider) {
      const idByKey = new Map(group.map((asset) => [asset.key, String(asset._id)]));

      let result: Awaited<ReturnType<typeof storageService.deleteFiles>>;

      try {
        result = await storageService.deleteFiles(
          group.map((asset) => asset.key),
          provider,
        );
      } catch (error) {
        // e.g. provider no longer configured: keep the records, report them.
        for (const asset of group) {
          failed.push({
            id: String(asset._id),
            key: asset.key,
            code: error instanceof AssetStorageError ? error.code : undefined,
            message: error instanceof Error ? error.message : undefined,
          });
        }

        continue;
      }

      for (const key of result.deleted) {
        const id = idByKey.get(key);

        if (id) deletedIds.push(id);
      }

      for (const item of result.failed) {
        failed.push({
          id: idByKey.get(item.key) ?? 'unknown',
          key: item.key,
          code: item.code,
          message: item.message,
        });
      }
    }

    if (deletedIds.length > 0) {
      await AssetModel.deleteMany({ _id: { $in: deletedIds } });
    }

    return { deleted: deletedIds, notFound, failed };
  }

  private buildListFilter(query: ListAssetsQuery): QueryFilter<Asset> {
    const filter: QueryFilter<Asset> = {};

    if (query.search) filter.$text = { $search: query.search };
    if (query.assetType) filter.assetType = query.assetType;
    if (query.mimeType) filter.mimeType = query.mimeType.toLowerCase();
    if (query.tag) filter.tags = query.tag.toLowerCase();
    if (query.visibility) filter.visibility = query.visibility;
    if (query.status) filter.status = query.status;

    if (query.folder) {
      const folder = query.folder.replace(/^\/+|\/+$/g, '');

      // Matches the folder itself and everything nested under it.
      filter.folder = new RegExp(`^${escapeRegex(folder)}(/|$)`);
    }

    return filter;
  }

  private async assertSlugAvailable(slug: string, excludeId?: string): Promise<void> {
    const conflict = await AssetModel.exists({
      slug,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });

    if (conflict) {
      throw AssetError.slugConflict(slug);
    }
  }

  /**
   * Best-effort removal of an orphaned stored object. Never throws, so the
   * original error (or a successful result) is not masked.
   */
  private async discardStoredFile(object: { key: string; provider: string }): Promise<void> {
    try {
      await storageService.deleteFile(object.key, object.provider);
    } catch (error) {
      logger.error(
        { err: error, provider: object.provider, key: object.key },
        'Failed to remove orphaned storage object',
      );
    }
  }
}

export const assetService = new AssetService();

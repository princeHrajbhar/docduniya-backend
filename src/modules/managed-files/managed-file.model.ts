import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { storedAssetSchema, type StoredAsset } from '../file-manager/index.js';

export interface IManagedFile {
  ownerId: Types.ObjectId;
  createdBy: Types.ObjectId;
  category: string;
  label?: string;
  asset: StoredAsset;
  metadata: Map<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

export type ManagedFileDocument = HydratedDocument<IManagedFile>;

const managedFileSchema = new Schema<IManagedFile>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 80,
      index: true,
    },
    label: { type: String, trim: true, maxlength: 200 },
    asset: { type: storedAssetSchema, required: true },
    metadata: { type: Map, of: String, default: {} },
  },
  { timestamps: true, optimisticConcurrency: true },
);

managedFileSchema.index({ ownerId: 1, createdAt: -1 });
managedFileSchema.index({ 'asset.provider': 1, createdAt: -1 });
managedFileSchema.index({ 'asset.storageKey': 1 }, { unique: true });

export const ManagedFile = model<IManagedFile>('ManagedFile', managedFileSchema);

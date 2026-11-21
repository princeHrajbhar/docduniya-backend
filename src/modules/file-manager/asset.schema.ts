import { Schema } from 'mongoose';
import type { StoredAsset } from './storage.types.js';

/** Reusable embedded schema for avatar, banner, resources, attachments, etc. */
export const storedAssetSchema = new Schema<StoredAsset>(
  {
    provider: { type: String, required: true, index: true },
    storageKey: { type: String, required: true },
    originalName: { type: String, required: true },
    sourceOriginalName: String,
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    extension: { type: String, required: true },
    visibility: { type: String, enum: ['public', 'private'], required: true },
    uploadedAt: { type: Date, required: true },
    title: { type: String, trim: true, maxlength: 200, default: '' },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    altText: { type: String, trim: true, maxlength: 300, default: '' },
    caption: { type: String, trim: true, maxlength: 500, default: '' },
    width: { type: Number, min: 1 },
    height: { type: Number, min: 1 },
    url: String,
    etag: String,
    version: Schema.Types.Mixed,
    resourceType: String,
    deliveryType: String,
    checksum: String,
    metadata: { type: Map, of: String },
  },
  { _id: false },
);

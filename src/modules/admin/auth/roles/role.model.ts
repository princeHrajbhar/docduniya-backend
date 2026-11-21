import { Schema, model } from 'mongoose';
import { ROLE_SLUG_PATTERN } from '../auth.constants.js';
import { ALL_PERMISSIONS, type Permission } from './permission.constants.js';

export interface IAccessRole {
  name: string;
  slug: string;
  description?: string;
  permissions: Permission[];
  /** System roles are seeded on startup; their names and permissions are immutable. */
  isSystem: boolean;
  isAssignable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const accessRoleSchema = new Schema<IAccessRole>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 80,
      match: ROLE_SLUG_PATTERN,
    },
    description: { type: String, trim: true, maxlength: 500 },
    permissions: [{ type: String, enum: ALL_PERMISSIONS }],
    isSystem: { type: Boolean, default: false, index: true },
    isAssignable: { type: Boolean, default: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);

accessRoleSchema.index({ name: 1 });

export const AccessRole = model<IAccessRole>('AccessRole', accessRoleSchema);

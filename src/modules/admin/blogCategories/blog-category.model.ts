import { Schema, model } from 'mongoose';

export interface IBlogCategory {
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

const blogCategorySchema = new Schema<IBlogCategory>(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 150 },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 150,
    },
  },
  { timestamps: true },
);

export const BlogCategory = model<IBlogCategory>('BlogCategory', blogCategorySchema);

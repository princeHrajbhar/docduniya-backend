import slugify from 'slugify';
import { AppError, ErrorCode } from '../../../utils/app-error.js';
import { isDuplicateKeyError } from '../../../utils/mongo.js';
import { BlogCategory } from './blog-category.model.js';
import type {
  CreateBlogCategoryInput,
  UpdateBlogCategoryInput,
} from './blog-category.validation.js';

const toSlug = (value: string) => slugify(value, { lower: true, strict: true, trim: true });
const notFound = () => new AppError('Category not found', 404, ErrorCode.NOT_FOUND);
const conflict = () =>
  new AppError('Category name or slug already exists', 409, ErrorCode.DUPLICATE_ENTRY);

class BlogCategoryService {
  async create(input: CreateBlogCategoryInput) {
    const slug = input.slug ?? toSlug(input.name);
    if (!slug) throw new AppError('Slug is required', 400, ErrorCode.VALIDATION_ERROR);
    if (await BlogCategory.exists({ $or: [{ name: input.name }, { slug }] })) throw conflict();

    try {
      return await BlogCategory.create({ name: input.name, slug });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw conflict();
      throw error;
    }
  }

  getAll() {
    return BlogCategory.find().sort({ createdAt: -1 }).lean();
  }

  async getById(id: string) {
    const category = await BlogCategory.findById(id).lean();
    if (!category) throw notFound();
    return category;
  }

  async getBySlug(slug: string) {
    const category = await BlogCategory.findOne({ slug }).lean();
    if (!category) throw notFound();
    return category;
  }

  async update(id: string, input: UpdateBlogCategoryInput) {
    try {
      const category = await BlogCategory.findByIdAndUpdate(
        id,
        { $set: input },
        { returnDocument: 'after', runValidators: true },
      ).lean();
      if (!category) throw notFound();
      return category;
    } catch (error) {
      if (isDuplicateKeyError(error)) throw conflict();
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const deleted = await BlogCategory.findByIdAndDelete(id).lean();
    if (!deleted) throw notFound();
  }
}

export const blogCategoryService = new BlogCategoryService();

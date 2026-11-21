import type { Request, Response } from 'express';
import { blogCategoryService } from './blog-category.service.js';
import type {
  CreateBlogCategoryInput,
  UpdateBlogCategoryInput,
} from './blog-category.validation.js';

type IdRequest = Request<{ id: string }>;

export async function createCategory(req: Request, res: Response) {
  const category = await blogCategoryService.create(req.body as CreateBlogCategoryInput);
  res.status(201).json({ success: true, message: 'Category created successfully', data: category });
}

export async function getCategories(_req: Request, res: Response) {
  res.json({ success: true, data: await blogCategoryService.getAll() });
}

export async function getCategoryById(req: IdRequest, res: Response) {
  res.json({ success: true, data: await blogCategoryService.getById(req.params.id) });
}

export async function getCategoryBySlug(req: Request<{ slug: string }>, res: Response) {
  res.json({ success: true, data: await blogCategoryService.getBySlug(req.params.slug) });
}

export async function updateCategory(req: IdRequest, res: Response) {
  const category = await blogCategoryService.update(
    req.params.id,
    req.body as UpdateBlogCategoryInput,
  );
  res.json({ success: true, message: 'Category updated successfully', data: category });
}

export async function deleteCategory(req: IdRequest, res: Response) {
  await blogCategoryService.delete(req.params.id);
  res.json({ success: true, message: 'Category deleted successfully' });
}

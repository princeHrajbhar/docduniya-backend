import type { FileStorageService } from './storage.service.js';
import type { GetAssetUrlOptions, StoredAsset } from './storage.types.js';

interface MongooseLikeDocument {
  toObject(): unknown;
}

const isMongooseLikeDocument = (value: unknown): value is MongooseLikeDocument =>
  Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { toObject?: unknown }).toObject === 'function',
  );

export const isStoredAsset = (value: unknown): value is StoredAsset => {
  if (!value || typeof value !== 'object') return false;
  const asset = value as Partial<StoredAsset>;

  return (
    typeof asset.storageKey === 'string' &&
    asset.storageKey.length > 0 &&
    (typeof asset.provider === 'string' || typeof asset.url === 'string')
  );
};

/**
 * Produces a response-safe clone and resolves URLs for every nested StoredAsset.
 * Useful for lists, populated documents, and deeply nested resource arrays.
 */
export const presentAssetUrls = async <T>(
  payload: T,
  storage: FileStorageService,
  options: GetAssetUrlOptions = {},
): Promise<T> => {
  const seen = new WeakMap<object, unknown>();

  const walk = async (node: unknown): Promise<unknown> => {
    if (node === null || typeof node !== 'object') return node;
    if (node instanceof Date) return new Date(node);

    const source = isMongooseLikeDocument(node) ? node.toObject() : node;
    if (source === null || typeof source !== 'object') return source;

    const cached = seen.get(source as object);
    if (cached) return cached;

    if (Array.isArray(source)) {
      const output: unknown[] = [];
      seen.set(source, output);
      for (const item of source) output.push(await walk(item));
      return output;
    }

    const output: Record<string, unknown> = {};
    seen.set(source as object, output);

    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      output[key] = await walk(value);
    }

    if (isStoredAsset(source)) {
      output.url = await storage.getUrl(source, options);
    }

    return output;
  };

  return (await walk(payload)) as T;
};

/**
 * Normalises a multipart blog form into plain JSON-shaped data before Zod
 * validation. Arrays may be sent as JSON strings, comma-separated values,
 * repeated `field[]` entries or bracket notation (`faq[0][question]`).
 */

type MultipartBody = Record<string, unknown>;

const hasOwn = (body: MultipartBody, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(body, key);

const asScalar = (value: unknown): unknown =>
  Array.isArray(value) ? value[value.length - 1] : value;

const tryParseJson = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('[') && !trimmed.startsWith('{'))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
};

const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => toStringArray(item))
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value !== 'string') return [];

  const parsed = tryParseJson(value);
  if (parsed !== value) return toStringArray(parsed);

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const readStringArray = (body: MultipartBody, field: string): string[] | undefined => {
  let present = false;
  const values: string[] = [];
  for (const key of [field, `${field}[]`]) {
    if (!hasOwn(body, key)) continue;
    present = true;
    values.push(...toStringArray(body[key]));
  }
  return present ? values : undefined;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toObjectArray = (value: unknown): Record<string, unknown>[] => {
  if (typeof value === 'string') {
    const parsed = tryParseJson(value);
    return parsed !== value ? toObjectArray(parsed) : [];
  }

  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object' && !Array.isArray(item),
    );
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const numericKeys = Object.keys(record)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b));
    return numericKeys.length ? numericKeys.flatMap((key) => toObjectArray(record[key])) : [record];
  }

  return [];
};

const readObjectArray = (
  body: MultipartBody,
  field: string,
  properties: readonly string[],
): Record<string, unknown>[] | undefined => {
  let present = false;
  const byIndex = new Map<number, Record<string, unknown>>();

  for (const directKey of [field, `${field}[]`]) {
    if (!hasOwn(body, directKey)) continue;
    present = true;
    toObjectArray(body[directKey]).forEach((item, index) => {
      byIndex.set(index, { ...(byIndex.get(index) ?? {}), ...item });
    });
  }

  const bracketPattern = new RegExp(
    `^${escapeRegExp(field)}\\[(\\d+)\\]\\[(${properties.map(escapeRegExp).join('|')})\\]$`,
  );

  for (const [key, rawValue] of Object.entries(body)) {
    const match = key.match(bracketPattern);
    const index = match?.[1];
    const property = match?.[2];
    if (index === undefined || property === undefined) continue;

    present = true;
    const position = Number(index);
    byIndex.set(position, {
      ...(byIndex.get(position) ?? {}),
      [property]: String(asScalar(rawValue) ?? ''),
    });
  }

  if (!present) return undefined;

  return [...byIndex.entries()].sort(([left], [right]) => left - right).map(([, value]) => value);
};

const readBoolean = (body: MultipartBody, field: string): boolean | undefined => {
  if (!hasOwn(body, field)) return undefined;
  const value = asScalar(body[field]);
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const MEDIA_SEO_PROPERTIES = ['storageKey', 'title', 'description', 'altText', 'caption'] as const;

export interface NormalizedBlogMultipartBody {
  data: Record<string, unknown>;
  controls: {
    retainedFileStorageKeys?: string[];
    removeBanner?: boolean;
    bannerSeo?: Record<string, unknown>;
    resourceSeo?: Record<string, unknown>[];
  };
}

export const normalizeBlogMultipartBody = (
  body: MultipartBody = {},
): NormalizedBlogMultipartBody => {
  const data: Record<string, unknown> = {};

  const scalarFields = [
    'title',
    'slug',
    'description',
    'category',
    'postingDate',
    'postedBy',
    'seoTitle',
    'seoDescription',
    'content',
    'status',
  ] as const;

  for (const field of scalarFields) {
    if (hasOwn(body, field)) data[field] = asScalar(body[field]);
  }

  const keyword = readStringArray(body, 'keyword');
  if (keyword !== undefined) data.keyword = keyword;

  const faq = readObjectArray(body, 'faq', ['question', 'answer']);
  if (faq !== undefined) data.faq = faq;

  const socialMediaLinks = readObjectArray(body, 'socialMediaLinks', ['platform', 'url']);
  if (socialMediaLinks !== undefined) data.socialMediaLinks = socialMediaLinks;

  const resourceLinks = readObjectArray(body, 'resourceLinks', ['title', 'url']);
  if (resourceLinks !== undefined) data.resourceLinks = resourceLinks;

  return {
    data,
    controls: {
      retainedFileStorageKeys: readStringArray(body, 'retainedFileStorageKeys'),
      removeBanner: readBoolean(body, 'removeBanner'),
      bannerSeo: readObjectArray(body, 'bannerSeo', MEDIA_SEO_PROPERTIES)?.[0],
      resourceSeo: readObjectArray(body, 'resourceSeo', MEDIA_SEO_PROPERTIES),
    },
  };
};

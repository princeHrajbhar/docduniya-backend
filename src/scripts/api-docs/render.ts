/** Renders JSON Schemas (from `z.toJSONSchema`) as Markdown field tables and example bodies. */

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  description?: string;
  $ref?: string;
};

export interface FieldRow {
  field: string;
  type: string;
  required: boolean;
  notes: string;
}

const OBJECT_ID = /a-fA-F0-9\]\{24\}|a-f0-9\]\{24\}/u;
const isNull = (schema: JsonSchema) => schema.type === 'null';
const variantsOf = (schema: JsonSchema) => schema.anyOf ?? schema.oneOf;

/** Collapses `X | null` and single-member unions; merges `allOf` intersections. */
function normalize(schema: JsonSchema): { schema: JsonSchema; nullable: boolean } {
  let current = schema;
  let nullable = false;
  for (;;) {
    const variants = variantsOf(current);
    if (variants) {
      const rest = variants.filter((variant) => !isNull(variant));
      if (rest.length < variants.length) nullable = true;
      if (rest.length === 1) {
        current = { ...current, anyOf: undefined, oneOf: undefined, ...rest[0] };
        continue;
      }
      current = { ...current, anyOf: rest, oneOf: undefined };
    }
    if (current.allOf?.length) {
      // Zod emits several string patterns (and intersections) as allOf; fold them into one schema.
      const merged: JsonSchema = { ...current, allOf: undefined };
      const patterns = current.pattern ? [current.pattern] : [];
      for (const part of current.allOf) {
        const inner = normalize(part).schema;
        merged.type ??= inner.type;
        if (inner.pattern) patterns.push(inner.pattern);
        if (inner.properties) merged.properties = { ...merged.properties, ...inner.properties };
        if (inner.required) merged.required = [...(merged.required ?? []), ...inner.required];
        for (const key of ['minLength', 'maxLength', 'format'] as const)
          if (inner[key] !== undefined && merged[key] === undefined)
            (merged as Record<string, unknown>)[key] = inner[key];
      }
      if (patterns.length) merged.pattern = patterns.join(' and ');
      current = merged;
      continue;
    }
    return { schema: current, nullable };
  }
}

function literal(value: unknown) {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

export function typeLabel(input: JsonSchema): string {
  const { schema, nullable } = normalize(input);
  let label: string;
  const variants = variantsOf(schema);
  if (schema.const !== undefined) label = literal(schema.const);
  else if (schema.enum) label = schema.enum.map(literal).join(' \\| ');
  else if (variants)
    label = variants.every((variant) => normalize(variant).schema.properties)
      ? `object (one of ${variants.length} variants)`
      : variants.map(typeLabel).join(' \\| ');
  else if (schema.type === 'array') {
    const item = schema.items ? typeLabel(schema.items) : 'any';
    label = item.includes(' ') && !item.startsWith('object') ? `array of (${item})` : `${item}[]`;
  } else if (schema.type === 'object' || schema.properties)
    label = schema.properties ? 'object' : 'object (map)';
  else if (schema.type === 'string') {
    if (schema.pattern && OBJECT_ID.test(schema.pattern)) label = 'ObjectId';
    else if (schema.format === 'date') label = 'date `YYYY-MM-DD`';
    else if (schema.format === 'date-time') label = 'date-time (ISO 8601)';
    else if (schema.format === 'email') label = 'email';
    else if (schema.format === 'uri' || schema.format === 'url') label = 'URL';
    else if (schema.format === 'uuid') label = 'UUID';
    else label = 'string';
  } else if (Array.isArray(schema.type)) label = schema.type.join(' \\| ');
  else label = schema.type ?? 'any';
  return nullable ? `${label} \\| null` : label;
}

function notes(input: JsonSchema): string {
  const { schema } = normalize(input);
  const parts: string[] = [];
  if (schema.description) parts.push(schema.description);
  if (schema.type === 'string') {
    const { minLength: min, maxLength: max } = schema;
    if (min !== undefined && max !== undefined)
      parts.push(min === max ? `${min} chars` : `${min}–${max} chars`);
    else if (min !== undefined && min > 0) parts.push(`min ${min} chars`);
    else if (max !== undefined) parts.push(`max ${max} chars`);
    if (schema.pattern && !OBJECT_ID.test(schema.pattern) && schema.format === undefined)
      parts.push(`pattern \`${schema.pattern.replace(/\|/gu, '\\|')}\``);
  }
  const low = schema.minimum ?? schema.exclusiveMinimum;
  const high = schema.maximum ?? schema.exclusiveMaximum;
  if (low !== undefined && Math.abs(low) < 1e15)
    parts.push(`${schema.exclusiveMinimum !== undefined ? '>' : '≥'} ${low}`);
  if (high !== undefined && Math.abs(high) < 1e15)
    parts.push(`${schema.exclusiveMaximum !== undefined ? '<' : '≤'} ${high}`);
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && schema.minItems > 0)
      parts.push(`min ${schema.minItems} items`);
    if (schema.maxItems !== undefined) parts.push(`max ${schema.maxItems} items`);
  }
  if (input.default !== undefined || schema.default !== undefined)
    parts.push(`default ${literal(input.default ?? schema.default)}`);
  return parts.join('; ').replace(/\n/gu, ' ');
}

/** Flattens a schema into dotted field rows (`a.b`, `items[].c`). */
export function fieldRows(
  schema: JsonSchema,
  prefix = '',
  required = true,
  out: FieldRow[] = [],
  selfRow = true,
) {
  const { schema: current } = normalize(schema);
  const variants = variantsOf(current);
  if (prefix && selfRow)
    out.push({ field: prefix, type: typeLabel(schema), required, notes: notes(schema) });
  if (variants && variants.some((variant) => normalize(variant).schema.properties)) {
    variants.forEach((variant, index) => {
      const tag = discriminator(variant);
      const label = `${prefix ? `${prefix} ` : ''}variant ${index + 1}${tag ? ` (${tag})` : ''}`;
      out.push({ field: `*${label}*`, type: 'object', required: false, notes: 'Send one variant' });
      fieldRows(variant, prefix, true, out, false);
    });
    return out;
  }
  if (current.properties) {
    const needed = new Set(current.required ?? []);
    for (const [key, child] of Object.entries(current.properties))
      fieldRows(child, prefix ? `${prefix}.${key}` : key, needed.has(key), out);
  } else if (current.type === 'array' && current.items) {
    const item = normalize(current.items).schema;
    if (item.properties || variantsOf(item)?.some((v) => normalize(v).schema.properties))
      fieldRows(current.items, `${prefix}[]`, true, out, false);
  } else if (
    typeof current.additionalProperties === 'object' &&
    normalize(current.additionalProperties).schema.properties
  ) {
    fieldRows(current.additionalProperties, `${prefix}.<key>`, true, out);
  }
  return out;
}

function discriminator(variant: JsonSchema): string | undefined {
  const { schema } = normalize(variant);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const value = normalize(child).schema;
    if (value.const !== undefined) return `${key} = ${literal(value.const)}`;
    if (value.enum?.length === 1) return `${key} = ${literal(value.enum[0])}`;
  }
  return undefined;
}

export function table(rows: FieldRow[]): string {
  const escape = (text: string) => text.replace(/(?<!\\)\|/gu, '\\|');
  return [
    '| Field | Type | Required | Notes |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${row.field.startsWith('*') ? row.field : `\`${row.field}\``} | ${row.type} | ${row.required ? 'yes' : ''} | ${escape(row.notes)} |`,
    ),
  ].join('\n');
}

const SAMPLE_ID = '665f1c2e9b1e4a0012345678';

/** A minimal example containing the required fields, using the first variant of a union. */
export function example(schema: JsonSchema, depth = 0): unknown {
  const { schema: current } = normalize(schema);
  if (depth > 8) return null;
  if (current.default !== undefined) return current.default;
  if (current.const !== undefined) return current.const;
  if (current.enum?.length) return current.enum[0];
  const variants = variantsOf(current);
  if (variants?.length) return example(variants[0]!, depth + 1);
  if (current.properties) {
    const out: Record<string, unknown> = {};
    for (const key of current.required ?? [])
      if (current.properties[key]) out[key] = example(current.properties[key], depth + 1);
    return out;
  }
  switch (current.type) {
    case 'array': {
      const count = Math.max(current.minItems ?? 0, 0);
      return current.items && count > 0
        ? Array.from({ length: count }, () => example(current.items!, depth + 1))
        : [];
    }
    case 'integer':
    case 'number':
      return (
        current.minimum ??
        (current.exclusiveMinimum !== undefined ? current.exclusiveMinimum + 1 : 1)
      );
    case 'boolean':
      return true;
    case 'string': {
      if (current.pattern && OBJECT_ID.test(current.pattern)) return SAMPLE_ID;
      if (current.format === 'date') return '2026-12-01';
      if (current.format === 'date-time') return '2026-12-01T10:00:00.000Z';
      if (current.format === 'email') return 'user@example.com';
      if (current.format === 'uri' || current.format === 'url') return 'https://example.com';
      const length = Math.max(current.minLength ?? 1, 1);
      if (current.pattern?.startsWith('^\\d')) return '1'.repeat(current.maxLength ?? length);
      const word = 'example text for this field. ';
      const size = Math.min(current.maxLength ?? Infinity, Math.max(length, 7));
      return word
        .repeat(Math.ceil(size / word.length))
        .slice(0, size)
        .trimEnd()
        .padEnd(length, 'x');
    }
    default:
      return current.type === 'object' ? {} : null;
  }
}

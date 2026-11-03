import { z } from 'zod';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The fields a schema does not name, at any depth, as dot paths. Stored schemas keep unknown
 * fields, which is right for a document from a newer app and wrong for a draft Claude writes,
 * where a misspelled field must fail instead of doing nothing. This reads the raw value rather
 * than sitting in a refinement, because zod skips refinements once a field has failed, and
 * publish reports every problem at once.
 */
export function unknownFields(schema: z.core.$ZodType, value: unknown, path: readonly PropertyKey[] = []): readonly string[] {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return unknownFields(schema.unwrap(), value, path);
  if (schema instanceof z.ZodArray) return Array.isArray(value) ? value.flatMap((item: unknown, i) => unknownFields(schema.element, item, [...path, i])) : [];
  if (!isRecord(value)) return [];
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const { discriminator } = schema.def;
    const option = schema.options.find((o) => o instanceof z.ZodObject && z.safeParse(o.shape[discriminator], value[discriminator]).success);
    return option === undefined ? [] : unknownFields(option, value, path);
  }
  if (!(schema instanceof z.ZodObject)) return [];
  const shape = new Map(Object.entries<z.core.$ZodType>(schema.shape));
  return Object.entries(value).flatMap(([key, field]) => {
    const inner = shape.get(key);
    return inner === undefined ? [z.core.toDotPath([...path, key])] : unknownFields(inner, field, [...path, key]);
  });
}

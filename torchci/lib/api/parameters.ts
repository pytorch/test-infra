import { queryParameters } from "lib/api/schema";
import { z } from "zod/v4";

export interface ParameterDefinition {
  schema: z.ZodType;
  encoding: "single" | "repeat" | "csv" | "json";
  legacyBracketValues?: boolean;
}

export type RawQuery = Record<string, string | string[] | undefined>;

// Keep registry order and each field's inferred type when building the strict
// request schema. The same definitions drive decoding and documentation.
export function parameterSchema<
  Definitions extends Record<string, ParameterDefinition>
>(definitions: Definitions) {
  return z.strictObject(
    Object.fromEntries(
      Object.entries(definitions).map(([name, definition]) => [
        name,
        definition.schema,
      ])
    ) as { [Name in keyof Definitions]: Definitions[Name]["schema"] }
  );
}

export function parameterQueryParameters(
  schema: z.ZodObject,
  definitions: Record<string, ParameterDefinition>
) {
  return queryParameters(
    schema,
    Object.fromEntries(
      Object.entries(definitions).map(([name, definition]) => [
        name,
        definition.encoding === "json"
          ? "json"
          : { style: "form", explode: definition.encoding === "repeat" },
      ])
    )
  );
}

function invalidParameter(name: string, input: unknown, message: string) {
  return {
    success: false as const,
    error: new z.ZodError([{ code: "custom", input, path: [name], message }]),
  };
}

// Repeated values are a set: deduplicated and sorted, so the normalized query,
// and therefore cursor identity, does not depend on their order in the URL.
export function canonicalValues<T extends string | number>(values: T[]): T[] {
  return Array.from(new Set(values)).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
}

// Allowed fields and defaults remain endpoint-specific; syntax and duplicate
// detection are shared by all sorted listings.
export function sortSchema(
  fields: readonly string[],
  defaults: readonly string[]
) {
  return z
    .array(
      z.enum(
        fields.flatMap((field) => [field, `-${field}`]),
        {
          error: `sort fields must be drawn from: ${fields.join(
            ", "
          )}; prefix a field with - for descending order`,
        }
      )
    )
    .min(1)
    .refine(
      (values) =>
        new Set(values.map((value) => value.replace(/^-/, ""))).size ===
        values.length,
      "sort must not repeat a field"
    )
    .default([...defaults]);
}

// requestQuery keeps repeated query parameters as arrays. Decode from the
// registry before validation, retaining exact values rather than splitting or
// trimming filters. Unknown names reach strictObject and are rejected,
// including old parameters whose semantics have changed.
export function parseParameters<S extends z.ZodObject>(
  rawQuery: RawQuery,
  definitions: Record<string, ParameterDefinition>,
  schema: S
) {
  const decoded: Record<string, unknown> = Object.create(null);
  for (const [name, raw] of Object.entries(rawQuery)) {
    if (raw === undefined) continue;
    const definition = Object.hasOwn(definitions, name)
      ? definitions[name]
      : undefined;
    if (
      (definition?.encoding === "single" || definition?.encoding === "json") &&
      Array.isArray(raw)
    ) {
      return invalidParameter(name, raw, `${name} must occur once`);
    }
    if (definition?.encoding === "json") {
      try {
        decoded[name] = JSON.parse(raw as string);
      } catch {
        return invalidParameter(name, raw, "must be valid JSON");
      }
    } else if (
      definition?.encoding === "repeat" ||
      definition?.encoding === "csv"
    ) {
      const values = Array.isArray(raw) ? raw : [raw];
      decoded[name] =
        definition.encoding === "csv"
          ? values.flatMap((value) =>
              value.split(",").map((part) => part.trim())
            )
          : values;
    } else {
      decoded[name] = raw;
    }
  }
  for (const [name, definition] of Object.entries(definitions)) {
    if (!definition.legacyBracketValues) continue;
    const entries = Object.entries(rawQuery).flatMap(([key, value]) => {
      if (
        !key.startsWith(`${name}[`) ||
        !key.endsWith("]") ||
        value === undefined
      )
        return [];
      delete decoded[key];
      return [
        [
          key.slice(name.length + 1, -1),
          Array.isArray(value) ? value : [value],
        ],
      ] as [string, string[]][];
    });
    if (entries.length > 0 && Object.hasOwn(decoded, name)) {
      return invalidParameter(
        name,
        rawQuery,
        "cannot combine JSON and bracket parameters"
      );
    }
    if (entries.length > 0) {
      decoded[name] = Object.fromEntries(entries);
    }
    // Zod's record parser otherwise silently removes this key and would
    // discard an explicit configuration constraint in either wire format.
    const value = decoded[name];
    if (
      value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, "__proto__")
    ) {
      return invalidParameter(
        name,
        value,
        `${name}[__proto__] is not supported`
      );
    }
  }
  return schema.safeParse(decoded);
}

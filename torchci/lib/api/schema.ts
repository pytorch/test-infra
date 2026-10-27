import { z } from "zod/v4";

// Shared pieces of /api/openapi.json: the error shape every endpoint answers
// with, what a resource contributes, and the conversion of zod schemas into
// OpenAPI parameter and schema objects.
// OpenAPI 3.1 schemas are JSON Schema 2020-12, which is what zod emits, so
// no translation is needed beyond dropping the per-schema `$schema` header.

export const ErrorResponseSchema = z
  .object({
    error: z.string().describe("Human-readable error message."),
    code: z
      .enum([
        "invalid_parameters",
        "invalid_cursor",
        "cursor_query_mismatch",
        "not_found",
        "internal_error",
      ])
      .describe(
        "Stable error code for programmatic handling. HTTP 400: invalid_parameters, invalid_cursor or cursor_query_mismatch; HTTP 404: not_found; HTTP 500: internal_error."
      ),
    issues: z
      .array(
        z.object({
          path: z
            .array(z.union([z.string(), z.number().int()]))
            .describe(
              "Parameter name followed by nested keys and numeric array indexes. Empty for a request-level issue."
            ),
          message: z.string().describe("Human-readable validation message."),
        })
      )
      .describe(
        "Collected validation issues, present for invalid_parameters only. Parameter decoding may stop at the first malformed value, so this is not necessarily every invalid parameter in the request."
      )
      .optional(),
  })
  .describe("The body of every documented error response.");

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

const PageLinkSchema = z
  .object({
    cursor: z
      .string()
      .describe(
        "Opaque cursor for this direction. Pass as cursor with the same endpoint, selection, filters and ordering; page size may change."
      ),
    url: z
      .string()
      .describe(
        "Relative URL for this page. Resolve against this response's URL. Preserves the request path and query parameters, including repeated values and page size, replacing only cursor."
      ),
  })
  .nullable();

export const PaginationSchema = z
  .object({
    next: PageLinkSchema.describe(
      "The next page; null when no later entries were found."
    ),
    previous: PageLinkSchema.describe(
      "The previous page; null when no earlier entries were found. Previous pages return the closest preceding entries in the requested order."
    ),
  })
  .describe(
    "Links in both directions. Both are null for an empty page; restart without cursor if live data changed."
  );

// Query implementations produce cursors without depending on the HTTP request.
// The shared list handler turns them into public page links.
export type ListPageData<Page extends { pagination: unknown }> = Omit<
  Page,
  "pagination"
> & {
  next_cursor: string | null;
  previous_cursor: string | null;
};

export type JsonSchema = Record<string, unknown>;

// Turns a registered component schema into the $ref of its component.
// (Underscored because the lint rule for unused variables also reads type
// signatures.)
export type SchemaRef = (_schema: z.ZodType) => { $ref: string };

// What a resource contributes to the document: its component schemas, keyed
// by their names in the document, and its paths, written against `ref` so
// responses point at the right component.
export interface ApiResource {
  schemas: Record<string, z.ZodType>;
  paths: (_ref: SchemaRef) => Record<string, unknown>;
}

// `io` picks the side of the schema: what clients send ("input", before
// defaults and coercion) or what they receive ("output").
export function jsonSchemaOf(
  schema: z.ZodType,
  io: "input" | "output"
): JsonSchema {
  const { $schema: _omitted, ...jsonSchema } = z.toJSONSchema(schema, { io });
  return jsonSchema;
}

interface QueryParameterBase {
  name: string;
  in: "query";
  required: boolean;
  description?: string;
}

type QueryParameterEncoding = { style: "form"; explode: boolean } | "json";

export type QueryParameterObject = QueryParameterBase &
  (
    | {
        schema: JsonSchema;
        style?: "form";
        explode?: boolean;
        content?: never;
      }
    | {
        content: { "application/json": { schema: JsonSchema } };
        schema?: never;
        style?: never;
        explode?: never;
      }
  );

// One OpenAPI query parameter per field of an object schema, in field order.
// A field is required when the schema rejects its absence. JSON content gives
// object parameters an unambiguous encoding, including nested arrays.
export function queryParameters(
  schema: z.ZodObject,
  encodings: Record<string, QueryParameterEncoding> = {}
): QueryParameterObject[] {
  return Object.entries(schema.shape).map(([name, fieldSchema]) => {
    const field = fieldSchema as z.ZodType;
    const { description, ...fieldJsonSchema } = jsonSchemaOf(field, "input");
    const encoding = encodings[name];
    return {
      name,
      in: "query",
      required: !field.safeParse(undefined).success,
      ...(typeof description === "string" ? { description } : {}),
      ...(encoding === "json"
        ? { content: { "application/json": { schema: fieldJsonSchema } } }
        : { schema: fieldJsonSchema, ...encoding }),
    };
  });
}

// The OpenAPI parameter for one {name} segment of a path; always required.
export function pathParameter(name: string, schema: z.ZodType) {
  const { description, ...pathSchema } = jsonSchemaOf(schema, "input");
  return {
    name,
    in: "path" as const,
    required: true,
    description,
    schema: pathSchema,
  };
}

export function jsonResponse(description: string, schema: { $ref: string }) {
  return {
    description,
    content: { "application/json": { schema } },
  };
}

export function errorResponse(ref: SchemaRef, description: string) {
  return jsonResponse(description, ref(ErrorResponseSchema));
}

// The components/schemas object for the given zod schemas, keyed by the
// component name; references between them become $refs. The names live in a
// registry of our own, fresh per call: `meta({ id })` would write into zod's
// global registry, which outlives module reloads in `next dev` and then
// rejects every id as a duplicate.
export function componentSchemas(
  schemasByName: Record<string, z.ZodType>
): Record<string, JsonSchema> {
  const registry = z.registry<{ id?: string }>();
  for (const [name, schema] of Object.entries(schemasByName)) {
    registry.add(schema, { id: name });
  }
  const generated = z.toJSONSchema(registry, {
    uri: (name) => `#/components/schemas/${name}`,
    io: "output",
  }).schemas;
  return Object.fromEntries(
    Object.entries(generated).map(([name, schema]) => {
      const { $schema: _header, ...rest } = schema as JsonSchema;
      return [name, rest];
    })
  );
}

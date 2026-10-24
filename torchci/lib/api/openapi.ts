import {
  ApiResource,
  componentSchemas,
  ErrorResponseSchema,
  SchemaRef,
} from "lib/api/schema";
import { commitRunsApiOpenApi } from "lib/api/tests/commit/openapi";
import { testsApiOpenApi } from "lib/api/tests/openapi";
import { runDetailApiOpenApi } from "lib/api/tests/run/openapi";
import { testDetailApiOpenApi } from "lib/api/tests/test/openapi";
import { runsApiOpenApi } from "lib/api/tests/test/runs/openapi";
import type { z } from "zod/v4";

// Every resource served under app/api is listed here; the document covers them
// all. Component names are unique across the document, whatever the domain.
const RESOURCES: ApiResource[] = [
  testsApiOpenApi,
  testDetailApiOpenApi,
  runsApiOpenApi,
  commitRunsApiOpenApi,
  runDetailApiOpenApi,
];

const SHARED_SCHEMAS: Record<string, z.ZodType> = {
  ErrorResponse: ErrorResponseSchema,
};

export function buildOpenApiDocument() {
  const schemasByName: Record<string, z.ZodType> = { ...SHARED_SCHEMAS };
  const nameOf = new Map<z.ZodType, string>(
    Object.entries(SHARED_SCHEMAS).map(([name, schema]) => [schema, name])
  );
  const ref: SchemaRef = (schema) => {
    const name = nameOf.get(schema);
    if (name === undefined) {
      throw new Error("a response points at a schema no resource registered");
    }
    return { $ref: `#/components/schemas/${name}` };
  };
  const paths: Record<string, unknown> = {};

  for (const resource of RESOURCES) {
    for (const [name, schema] of Object.entries(resource.schemas)) {
      if (name in schemasByName) {
        throw new Error(`two resources register the component ${name}`);
      }
      schemasByName[name] = schema;
      nameOf.set(schema, name);
    }
  }
  for (const resource of RESOURCES) {
    for (const [path, item] of Object.entries(resource.paths(ref))) {
      if (path in paths) {
        throw new Error(`two resources describe ${path}`);
      }
      paths[path] = item;
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "PyTorch HUD API",
      // The API has no version; the document describes what this deploy serves.
      version: process.env.VERCEL_GIT_COMMIT_SHA || "development",
      description:
        "Generated from the zod schemas the HUD API handlers validate with. The API is unversioned: endpoints change together with their consumers, and info.version names the deploy that serves this document.",
    },
    servers: [{ url: "https://hud.pytorch.org" }],
    paths,
    components: { schemas: componentSchemas(schemasByName) },
  };
}

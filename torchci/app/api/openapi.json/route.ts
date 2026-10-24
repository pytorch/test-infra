import { buildOpenApiDocument } from "lib/api/openapi";

// GET /api/openapi.json
//
// The OpenAPI 3.1 description of every other route under app/api, generated
// from the zod schemas the handlers validate with. Built once per process: it
// only changes with a deploy.
const document = buildOpenApiDocument();

export function GET(): Response {
  return Response.json(document, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}

export const dynamic = "force-dynamic";

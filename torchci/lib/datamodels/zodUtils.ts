import { ZodError } from "zod";

export function formatZodError(error: ZodError): string[] {
  return error.errors.map((e) => {
    const path = e.path.length > 0 ? e.path.join(".") : "(root)";
    return `${path}: ${e.message}`;
  });
}

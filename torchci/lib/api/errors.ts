import type { z } from "zod/v4";

// Include the parameter and any nested key/index; object-level issues such as
// unknown parameters already name the offending keys in their message.
export function parameterError(issue: z.ZodError["issues"][number]): string {
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

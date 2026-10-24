import type { ErrorResponse } from "lib/api/schema";
import type { z } from "zod/v4";

// Include the parameter and any nested key/index; object-level issues such as
// unknown parameters already name the offending keys in their message.
export function parameterError(issue: z.ZodError["issues"][number]): string {
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

// Only expose public paths and messages. Decoder issues can carry the raw
// input, including an entire query object, so never copy the issues wholesale.
export function parameterIssues(
  error: z.ZodError
): NonNullable<ErrorResponse["issues"]> {
  return error.issues.flatMap((issue) => {
    const path = issue.path.map((part) =>
      typeof part === "number" ? part : String(part)
    );
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: [...path, key],
        message: `Unrecognized key: ${JSON.stringify(key)}`,
      }));
    }
    return [{ path, message: issue.message }];
  });
}

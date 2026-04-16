// TypeScript defaults error type to unknown, this file is to handle error messages and types.

type ErrorWithMessage = {
  message: string;
};

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

function toErrorWithMessage(candidate: unknown): ErrorWithMessage {
  if (isErrorWithMessage(candidate)) {
    return candidate;
  }
  try {
    return new Error(JSON.stringify(candidate));
  } catch {
    return new Error(String(candidate));
  }
}
export function getErrorMessage(error: unknown) {
  return toErrorWithMessage(error).message;
}

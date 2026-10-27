import { Alert, Button } from "@mui/material";
import { apiErrorMessage } from "lib/tests/table";

// A request to the API failed, its retries spent: the API's error text and a
// Retry button that asks again.
export default function LoadError({
  what,
  error,
  onRetry,
}: {
  // What could not be loaded, as the sentence says it: "tests", "the
  // choices".
  what: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <Alert
      severity="error"
      action={
        <Button color="inherit" size="small" onClick={() => onRetry()}>
          Retry
        </Button>
      }
    >
      Could not load {what}: {apiErrorMessage(error)}
    </Alert>
  );
}

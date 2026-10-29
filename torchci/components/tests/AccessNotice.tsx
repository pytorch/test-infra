import { Alert, Button } from "@mui/material";
import { signIn } from "next-auth/react";

// Why the page shows no tests: GET /api/tests is behind the HUD GitHub gate,
// write access to pytorch/pytorch, and the reader is not signed in, signed
// in with a session GitHub no longer accepts, or signed in without that
// access. The first two offer the sign-in; nothing is asked of the API until
// it is done.
export type AccessReason = "signed_out" | "expired" | "forbidden";

const SENTENCES: Record<AccessReason, string> = {
  signed_out:
    "Sign in with GitHub to see this page. It needs write access to pytorch/pytorch.",
  expired: "Your sign-in no longer works. Sign in again to see this page.",
  forbidden:
    "This page needs write access to pytorch/pytorch, which your GitHub account does not have.",
};

export default function AccessNotice({ reason }: { reason: AccessReason }) {
  const offersSignIn = reason !== "forbidden";
  return (
    <Alert
      severity={offersSignIn ? "info" : "warning"}
      action={
        offersSignIn ? (
          <Button color="inherit" size="small" onClick={() => void signIn()}>
            Sign in
          </Button>
        ) : undefined
      }
    >
      {SENTENCES[reason]}
    </Alert>
  );
}

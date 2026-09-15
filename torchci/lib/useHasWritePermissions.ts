// Whether the signed-in user clears the shared HUD GitHub gate -- write access
// to pytorch/pytorch, or the allow list in lib/auth/allowList.json.
//
// The gate itself lives on the server (authorizeGithubToken), and this asks
// /api/check-write-permissions rather than reimplementing it: a second copy of
// that rule in the browser is a copy that can drift from the one the API routes
// actually enforce. So this is only ever for deciding what to OFFER. Every route
// behind the gate re-checks it, and nothing here is a substitute for that.
//
// SWR dedups by key, so a page rendering several gated controls still costs one
// request.

import { fetcher } from "lib/GeneralUtils";
import { useSession } from "next-auth/react";
import useSWR from "swr";

export type WriteAccess =
  /** Not signed in, or the answer has not come back yet. */
  "unknown" | "yes" | "no";

export function useHasWritePermissions(): WriteAccess {
  const session = useSession();
  const signedIn = session.status === "authenticated" && session.data !== null;

  // A null key is how SWR is told not to fetch; the route answers 401 to an
  // anonymous caller anyway, but there is no reason to ask.
  const { data, error } = useSWR(
    signedIn ? "/api/check-write-permissions" : null,
    fetcher,
    {
      // The answer changes when someone's repo permissions change, which is not
      // something a HUD tab needs to poll for.
      revalidateOnFocus: false,
    }
  );

  if (!signedIn) {
    return "unknown";
  }
  if (error) {
    return "no";
  }
  if (data === undefined) {
    return "unknown";
  }
  // The route answers 403/401 with `{ error }` and 200 with `{ authorized: true }`,
  // and `fetcher` does not distinguish the two by status -- so read the field
  // rather than the mere presence of a body.
  return data?.authorized === true ? "yes" : "no";
}

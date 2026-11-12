import type { CommitGreenlight } from "lib/api/tests/commit/greenlight/types";
import { isGreenlightRepo } from "lib/greenlight/greenlightConfig";
import { commitGreenlightApiUrl } from "lib/tests/commitPage";
import {
  CommitGreenlightState,
  commitGreenlightState,
  greenlightRefreshMs,
} from "lib/tests/greenlight";
import { useApiResource } from "lib/tests/useApiResource";
import { useEffect, useState } from "react";

// What a commit's page has to show for GreenLight's verdict on the commit,
// from GET /api/tests/commit/{sha}/greenlight, read as the hooks read the
// API (useApiResource): the verdict, that there is none and why, that it
// could not be read, or that the answer is on its way
// (commitGreenlightState). Asked once, and again every minute only while a
// review is in flight (greenlightRefreshMs). Null, and nothing asked, until
// the repository and the commit are known and for a repository GreenLight
// does not review, which is known without asking: the header holds no place
// for a pill that will not come.
export function useCommitGreenlight(
  repo: string | undefined,
  sha: string | undefined
): CommitGreenlightState | null {
  const [owner, name] = repo?.split("/") ?? [];
  const url =
    repo === undefined ||
    sha === undefined ||
    owner === undefined ||
    name === undefined ||
    !isGreenlightRepo(owner, name)
      ? null
      : commitGreenlightApiUrl(repo, sha);
  // How long until the verdict is asked for again, decided anew from each
  // answer and given to SWR as a number. SWR takes a function of the answer
  // too, but reads it only as the hook mounts, before there is an answer,
  // and after each refresh: one that says "never" for no answer starts
  // asking only when it is a new function at the render the answer arrives
  // in, which nothing would keep true.
  const [refreshMs, setRefreshMs] = useState(0);
  const { data, error, retry } = useApiResource<CommitGreenlight>(url, {
    refreshInterval: refreshMs,
  });
  useEffect(() => {
    setRefreshMs(greenlightRefreshMs(data?.verdict, new Date()));
  }, [data]);
  return url === null ? null : commitGreenlightState(data, error, retry);
}

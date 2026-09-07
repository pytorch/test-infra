// Lists the workflow files that actually exist in a repo's default branch.
//
// The ClickHouse side of the OSDC migration page can only see files that ran CI
// in the query window, so it undercounts: a workflow that has not fired recently
// is absent entirely. This gives the page a current-file inventory, cheaply --
// one directory read per repo, no YAML parsing.
import { getOctokit } from "lib/github";
import { OSDC_TRACKED_REPOS } from "lib/osdcMigrationRepos";
import type { NextApiRequest, NextApiResponse } from "next";

const ALLOWED_REPOS = new Set(OSDC_TRACKED_REPOS);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (Object.keys(req.query).some((key) => key !== "repo")) {
    return res.status(400).json({ error: "Unexpected query parameter" });
  }

  const { repo } = req.query;
  if (typeof repo !== "string") {
    return res.status(400).json({ error: "repo must be a single string" });
  }
  if (!ALLOWED_REPOS.has(repo)) {
    return res.status(403).json({ error: "Repository not allowed" });
  }
  const [owner, name] = repo.split("/");

  try {
    const octokit = await getOctokit(owner, name);
    const contents = await octokit.rest.repos.getContent({
      owner,
      repo: name,
      path: ".github/workflows",
    });
    if (!Array.isArray(contents.data)) {
      throw new Error("Workflow path is not a directory");
    }

    const all = contents.data
      .filter(
        (entry) =>
          entry.type === "file" &&
          (entry.path.endsWith(".yml") || entry.path.endsWith(".yaml"))
      )
      .map((entry) => entry.path)
      .sort();

    // Drop `_`-prefixed files. By convention across these repos those are
    // workflow_call-only helpers (_linux-build.yml, _fbgemm_gpu_cuda_test.yml,
    // _unittest.yml). They never emit a workflow_run of their own -- their jobs
    // are attributed to the caller's path -- so listing them would park
    // permanently-unmigratable rows in every repo's table.
    //
    // The API also returns `allFiles`, which the page uses to recognize current
    // observed paths. A `_` workflow that does run standalone (pytorch's
    // _binary-build-flash-attention-wheel-*.yml) therefore still arrives from
    // ClickHouse and remains in the table.
    //
    // Convention-based, so it is not exhaustive -- callees without the prefix
    // (torchtitan's set-matrix.yaml, helion's compute-benchmark-matrix.yml) are
    // still counted. Catching those needs an `on:` parse of each file.
    const files = all.filter((p) => !p.split("/").pop()!.startsWith("_"));

    const reusableExcluded = all.length - files.length;

    // Cache aggressively: the workflow file list changes on the order of days.
    res.setHeader(
      "Cache-Control",
      "s-maxage=3600, stale-while-revalidate=86400"
    );
    res.status(200).json({
      repo,
      // getContent lists at most 1000 directory entries
      truncated: contents.data.length >= 1000,
      reusableExcluded,
      allFiles: all,
      files,
    });
  } catch (error) {
    console.error(`Failed to list workflows for ${repo}:`, error);
    res.status(500).json({ error: "Failed to list workflow files" });
  }
}

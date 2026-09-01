// Lists the workflow files that actually exist in a repo's default branch.
//
// The ClickHouse side of the OSDC migration page can only see files that ran CI
// in the query window, so it undercounts: a workflow that has not fired recently
// is absent entirely. This gives the page a current-file inventory, cheaply --
// one tree read per repo, no YAML parsing.
import { getOctokit } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const repo = req.query.repo as string;
  const [owner, name] = (repo ?? "").split("/");
  if (!owner || !name) {
    return res.status(400).json({ error: "repo must be <owner>/<name>" });
  }

  try {
    const octokit = await getOctokit(owner, name);
    const repoInfo = await octokit.rest.repos.get({ owner, repo: name });
    const tree = await octokit.rest.git.getTree({
      owner,
      repo: name,
      tree_sha: repoInfo.data.default_branch,
      recursive: "1",
    });

    const all = tree.data.tree
      .filter(
        (t) =>
          t.type === "blob" &&
          t.path !== undefined &&
          t.path.startsWith(".github/workflows/") &&
          (t.path.endsWith(".yml") || t.path.endsWith(".yaml"))
      )
      .map((t) => t.path as string)
      .sort();

    // Drop `_`-prefixed files. By convention across these repos those are
    // workflow_call-only helpers (_linux-build.yml, _fbgemm_gpu_cuda_test.yml,
    // _unittest.yml). They never emit a workflow_run of their own -- their jobs
    // are attributed to the caller's path -- so counting them in the denominator
    // would park permanently-unmigratable rows in every repo's percentage.
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

    // Cache aggressively: the workflow file list changes on the order of days,
    // and this is only a denominator.
    res.setHeader(
      "Cache-Control",
      "s-maxage=3600, stale-while-revalidate=86400"
    );
    res.status(200).json({
      repo,
      defaultBranch: repoInfo.data.default_branch,
      truncated: tree.data.truncated,
      reusableExcluded,
      allFiles: all,
      files,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "failed to list workflows" });
  }
}

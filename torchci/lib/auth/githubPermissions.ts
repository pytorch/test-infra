import type { Octokit } from "octokit";

// Whether the user may push to the repository: GitHub's collaborator
// permission is admin or write. On its own here, with no imports beyond a
// type, so the server-side gates can use it from the App Router build, which
// refuses the page components lib/GeneralUtils.ts reaches.
export async function hasWritePermissionsUsingOctokit(
  octokit: Octokit,
  username: string,
  owner: string,
  repo: string
): Promise<boolean> {
  const res = await octokit.rest.repos.getCollaboratorPermissionLevel({
    owner: owner,
    repo: repo,
    username: username,
  });
  const permissions = res?.data?.permission;
  return permissions === "admin" || permissions === "write";
}

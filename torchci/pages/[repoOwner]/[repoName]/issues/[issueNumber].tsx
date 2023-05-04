import { useRouter } from "next/router";
import React from "react";

export default function Page() {
  const router = useRouter();
  const { repoOwner, repoName, issueNumber } = router.query;
  if (repoOwner && repoName && issueNumber) {
    const githubLink = `https://github.com/${repoOwner}/${repoName}/issues/${issueNumber}`;
    window.location.replace(githubLink);
    return (
      <div>
        Redirecting to <a href={githubLink}>github</a>
      </div>
    );
  }
}

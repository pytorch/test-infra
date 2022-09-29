import { useRouter } from "next/router";
import React, { useEffect } from "react";


export default function Page() {
  const router = useRouter();
  const { repoOwner, repoName, issueNumber } = router.query;
    if (repoOwner && repoName && issueNumber) {
      window.location.href = `https://github.com/${repoOwner}/${repoName}/issues/${issueNumber}`;
      console.log("adsf");
    }
  return <div>redirecting to github</div>;
}

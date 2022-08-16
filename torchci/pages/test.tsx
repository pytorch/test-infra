import React from "react";
import { useSession, signIn, signOut } from "next-auth/react";

export default function MePage() {
  const session = useSession();
  console.log("DATA IS", session.data);

  const handleClick = async () => {
    const response = await fetch(
      "https://api.github.com/repos/pytorch/test-infra/issues",
      {
        method: "POST",
        body: JSON.stringify({
          title: "Found a bug",
          body: "I'''m having a problem with this.",
          assignees: ["octocat"],
          milestone: 1,
          labels: ["bug"],
        }),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `token ${session.data.accessToken}`,
        },
      }
    );
    console.log("RESPONSE IS");
  };

  return (
    <div>
      <a
        href={`/api/auth/signin`}
        onClick={(e) => {
          e.preventDefault();
          signIn();
        }}
      >
        Sign in
      </a>
      <a
        href={`/api/auth/signout`}
        onClick={(e) => {
          e.preventDefault();
          signOut();
        }}
      >
        Sign out
      </a>
      <div>
        <button onClick={handleClick}>Click me</button>
      </div>
      <pre>{JSON.stringify(session, null, 2)}</pre>
    </div>
  );
}

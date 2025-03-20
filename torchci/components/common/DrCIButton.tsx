import { Button, CircularProgress, Tooltip } from "@mui/material";
import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

export default function DrCIButton({
  owner,
  repo,
  prNumber,
}: {
  owner: string;
  repo: string;
  prNumber: number;
}) {
  const session = useSession();
  const loggedIn = session.status === "authenticated" && session.data !== null;
  // loading, clickable, failed, rateLimited
  const [buttonState, setButtonState] = useState("clickable");

  const url = `/api/drci/drci?prNumber=${prNumber}`;
  if (buttonState == "loading" && loggedIn) {
    fetch(url, {
      method: "POST",
      body: JSON.stringify({ repo }),
      headers: {
        Authorization: session.data!["accessToken"],
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
      },
    }).then((res) => {
      if (res.status == 429) {
        setButtonState("rateLimited");
        return;
      }
      if (!res.ok) {
        setButtonState("failed");
        return;
      }
      setButtonState("clickable");
      return res.json();
    });
  }

  useEffect(() => {
    if (buttonState == "failed" || buttonState == "rateLimited") {
      setTimeout(() => {
        setButtonState("clickable");
      }, 5000);
    }
  }, [buttonState]);

  return (
    <Tooltip
      title={
        owner == "pytorch"
          ? loggedIn
            ? "Click to update Dr. CI.  This might take a while."
            : "You must be logged in to update Dr. CI"
          : "Dr. CI is only available for pytorch org PRs"
      }
    >
      <span>
        <Button
          variant="contained"
          disableElevation
          disabled={
            !loggedIn || buttonState != "clickable" || owner != "pytorch"
          }
          onClick={() => {
            setButtonState("loading");
          }}
        >
          {buttonState == "loading" && (
            <CircularProgress
              size={20}
              sx={{
                color: "primary",
                position: "absolute",
                top: "50%",
                left: "50%",
                marginTop: "-10px",
                marginLeft: "-10px",
              }}
            />
          )}
          {buttonState == "rateLimited"
            ? "Exceeded Rate Limit"
            : buttonState == "failed"
            ? "Failed to Update"
            : "Update Dr. CI"}
        </Button>
      </span>
    </Tooltip>
  );
}

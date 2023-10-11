
import React from "react";
import { JobData, LogAnnotation } from "../lib/types";
import { ToggleButtonGroup, ToggleButton } from "@mui/material";
import { useSession } from "next-auth/react";

export default function LogAnnotationToggle({
  job,
  annotation,
  repo = null,
  log_metadata,
}: {
  job: JobData;
  annotation: LogAnnotation;
  repo?: string | null;
  log_metadata: Record<string, string>;
}) {

  const [state, setState] = React.useState<LogAnnotation>(
    (annotation ?? "null") as LogAnnotation
  );
  const session = useSession();
  async function handleChange(
    _: React.MouseEvent<HTMLElement>,
    newState: LogAnnotation
  ) {
    setState(newState);
    const all_metadata = log_metadata;
    all_metadata["job_id"] = job.id ?? "";
    await fetch(`/api/log_annotation/${repo ?? job.repo}/${newState}`, {
      method: "POST",
      body: JSON.stringify(all_metadata),
    });
  }

  return (
    <>
      Which log is preferable:{" "}
      <ToggleButtonGroup
        value={state}
        exclusive
        onChange={handleChange}
        disabled={session.status !== "authenticated"}
      >
        {Object.keys(LogAnnotation).map((annotation, ind) => {
          return (
            <ToggleButton
              key={ind}
              value={annotation}
              style={{ height: "12pt", textTransform: "none" }}
            >
              {
                //@ts-ignore
                LogAnnotation[annotation]
              }
            </ToggleButton>
          );
        })}
      </ToggleButtonGroup>
    </>
  );
}

import React from "react";
import { JobData } from "../lib/types";
import { ToggleButtonGroup, ToggleButton } from "@mui/material";
import { useSession } from "next-auth/react";

export enum JobAnnotation {
  NULL = "None",
  BROKEN_TRUNK = "Broken Trunk",
  TEST_FLAKE = "Test Flake",
  INFRA_BROKEN = "Broken Infra",
  INFRA_FLAKE = "Infra Flake",
  NETWORK = "Network Error",
  OTHER = "Other"
}

export default function JobAnnotationToggle({
  job,
  annotation,
  repo = null,
}: {
  job: JobData;
  annotation: JobAnnotation;
  repo?: string | null;
}) {
  const [state, setState] = React.useState<JobAnnotation>(
    (annotation ?? "null") as JobAnnotation
  );
  const session = useSession();
  async function handleChange(
    _: React.MouseEvent<HTMLElement>,
    newState: JobAnnotation
  ) {
    setState(newState);
    await fetch(
      `/api/job_annotation/${repo ?? job.repo}/${job.id}/${newState}`,
      {
        method: "POST",
      }
    );
  }

  return (
    <>
      Classify failure:{" "}
      <ToggleButtonGroup
        value={state}
        exclusive
        onChange={handleChange}
        disabled={session.status !== "authenticated"}
      >
        {Object.keys(JobAnnotation).map((annotation, ind) => {
          return (
            <ToggleButton
              key={ind}
              value={annotation}
              style={{ height: "12pt", textTransform: "none" }}
            >
              {
                //@ts-ignore
                JobAnnotation[annotation]
              }
            </ToggleButton>
          );
        })}
      </ToggleButtonGroup>
    </>
  );
}

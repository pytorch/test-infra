"use client";

import styled from "@mui/system/styled";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((res) => res.json());
export default function GitHubIncidentBanner() {
  const { data, error } = useSWR(
    "https://www.githubstatus.com/api/v2/incidents/unresolved.json",
    fetcher,
    { refreshInterval: 2 * 60 * 1000 } // every 2 minutes
  );

  if (error || !data?.incidents?.length) return null;

  const incident = data.incidents[0];
  const lastUpdate = incident.incident_updates?.[0]?.created_at;
  const lastUpdateDate = lastUpdate
    ? new Date(lastUpdate).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  return (
    <Banner>
      <Title>GitHub Incident:</Title> {incident.name}
      {lastUpdateDate && <> — Updated: {lastUpdateDate}</>}{" "}
      <a href={incident.shortlink} target="_blank" rel="noreferrer">
        (link)
      </a>
    </Banner>
  );
}

const Banner = styled("div")({
  fontSize: "0.875rem",
  color: "#666",
  padding: "6px 12px",
  borderRadius: "4px",
  marginBottom: "8px",
  display: "inline-block",
  outline: "1px solid #ccc",
});

const Title = styled("span")({
  fontWeight: 600,
  marginRight: "4px",
});

import styled from "@emotion/styled";
import useSWR from "swr";

const Banner = styled("div")({
  backgroundColor: "#f5f5f5",
  color: "#333",
  border: "1px solid #ccc",
  borderRadius: "6px",
  padding: "0.5rem 0.75rem",
  fontSize: "0.75rem",
  maxWidth: "600px",
  boxShadow: "0 2px 6px rgba(0, 0, 0, 0.08)",
  zIndex: 1000,
});

const Title = styled("span")({
  fontWeight: "bold",
  marginBottom: "4px",
});

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function GitHubIncidentBanner() {
  const { data, error } = useSWR("/api/issue/github_incident", fetcher, {
    refreshInterval: 600_000, // every 10 minutes
  });

  const incident = data?.latest;
  // no UI rendering if there is an error or no incident
  if (!incident || error) return null;
  const lastUpdate = incident.incident_updates?.[0]?.created_at;
  const lastUpdateDate = lastUpdate
    ? new Date(lastUpdate).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  return (
    <Banner>
      <Title>GitHub Incident: </Title>
      <span>
        {incident.name}
        {lastUpdateDate && <span>, Updated: {lastUpdateDate}</span>}
        <a href={incident.shortlink} target="_blank" rel="noreferrer">
          (link)
        </a>
      </span>
    </Banner>
  );
}

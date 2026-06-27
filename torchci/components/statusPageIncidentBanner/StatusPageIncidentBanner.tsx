import styled from "@mui/system/styled";
import useSWR from "swr";
import styles from "../sevReport/SevReport.module.css";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

interface StatusPageIncidentBannerProps {
  statusPageUrl: string;
  serviceName: string;
}

export default function StatusPageIncidentBanner({
  statusPageUrl,
  serviceName,
}: StatusPageIncidentBannerProps) {
  const { data, error } = useSWR(
    `${statusPageUrl}/api/v2/incidents/unresolved.json`,
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
    <div
      className={styles.sevBox}
      style={{ backgroundColor: "var(--background-color)" }}
    >
      <Title>{serviceName} Incident:</Title> {incident.name}
      {lastUpdateDate && <> — Updated: {lastUpdateDate}</>}{" "}
      <a href={incident.shortlink} target="_blank" rel="noreferrer">
        (link)
      </a>
    </div>
  );
}

const Title = styled("span")({
  fontWeight: 600,
  marginRight: "4px",
});

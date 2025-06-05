'use client';

import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then(res => res.json());
export default function GitHubIncidentBanner() {
  const { data, error } = useSWR(
    'https://www.githubstatus.com/api/v2/incidents/unresolved.json',
    fetcher,
    { refreshInterval: 5 * 60 * 1000 }
  );

  if (error || !data?.incidents?.length) return null;

  const incident = data.incidents[0];
  const lastUpdate = incident.incident_updates?.[0]?.created_at;
  const lastUpdateDate = lastUpdate
    ? new Date(lastUpdate).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  return (
    <div style={{ fontSize: '14px', color: '#666', background: '#f4f4f4', padding: '6px 10px', borderRadius: '4px' }}>
      <strong>GitHub Incident:</strong>{' '}
      {incident.name}
      {lastUpdateDate && <> — Updated: {lastUpdateDate}</>}
      {' '}
      <a href={incident.shortlink} target="_blank" rel="noreferrer">
        (link)
      </a>
    </div>
  );
}

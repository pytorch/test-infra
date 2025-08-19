import LoadingPage from "components/common/LoadingPage";
import { useSetTitle } from "components/layout/DynamicTitle";
import { RunnersApiResponse } from "pages/api/runners/[org]";
import { useRouter } from "next/router";
import { useState } from "react";
import useSWR from "swr";
import styles from "./runners.module.css";

const fetcher = async (url: string): Promise<RunnersApiResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(errorData.error || `HTTP ${res.status}`);
  }
  return res.json();
};

const RunnerStatus = ({ status, busy }: { status: string; busy: boolean }) => {
  const getStatusColor = () => {
    if (status === "offline") return "#6a737d";
    if (busy) return "#f66a0a";
    return "#28a745";
  };

  const getStatusText = () => {
    if (status === "offline") return "Offline";
    if (busy) return "Busy";
    return "Idle";
  };

  return (
    <div className={styles.statusContainer}>
      <div 
        className={styles.statusDot}
        style={{ backgroundColor: getStatusColor() }}
      ></div>
      <span className={styles.statusText}>{getStatusText()}</span>
    </div>
  );
};

const RunnerLabels = ({ labels }: { labels: Array<{ name: string; type: string }> }) => {
  return (
    <div className={styles.labelsContainer}>
      {labels.map((label, index) => (
        <span
          key={index}
          className={`${styles.label} ${
            label.type === "custom" ? styles.customLabel : styles.readOnlyLabel
          }`}
        >
          {label.name}
        </span>
      ))}
    </div>
  );
};

export default function RunnersDemo() {
  const router = useRouter();
  const { org } = router.query;
  const [searchQuery, setSearchQuery] = useState("");

  useSetTitle(`Runners Demo - ${org || "pytorch"}`);

  // Use mock endpoint for demo
  const { data, error } = useSWR(
    `/api/runners/mock`,
    fetcher,
    {
      refreshInterval: 30000, // Refresh every 30 seconds
      revalidateOnFocus: true,
    }
  );

  if (error) {
    return (
      <div className={styles.container}>
        <h1>GitHub Runners - {org || "pytorch"} (Demo)</h1>
        <div className={styles.error}>
          <h2>Error loading runners</h2>
          <p>{error.message}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return <LoadingPage />;
  }

  // Filter runners based on search query
  const filteredRunners = data.runners.filter(runner =>
    runner.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    runner.os.toLowerCase().includes(searchQuery.toLowerCase()) ||
    runner.labels.some(label => 
      label.name.toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  const onlineRunners = data.runners.filter(r => r.status === "online").length;
  const busyRunners = data.runners.filter(r => r.busy).length;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>GitHub Runners - {org || "pytorch"} (Demo)</h1>
        <div className={styles.summary}>
          <span className={styles.summaryItem}>
            <strong>{data.total_count}</strong> total runners
          </span>
          <span className={styles.summaryItem}>
            <strong>{onlineRunners}</strong> online
          </span>
          <span className={styles.summaryItem}>
            <strong>{busyRunners}</strong> busy
          </span>
        </div>
      </div>

      <div className={styles.controls}>
        <input
          type="text"
          placeholder="Filter runners by name, OS, or labels..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className={styles.searchInput}
        />
      </div>

      <div className={styles.tableContainer}>
        <table className={styles.runnersTable}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>OS</th>
              <th>Labels</th>
              <th>ID</th>
            </tr>
          </thead>
          <tbody>
            {filteredRunners.length > 0 ? (
              filteredRunners.map((runner) => (
                <tr key={runner.id} className={styles.runnerRow}>
                  <td className={styles.runnerName}>
                    <span className={styles.name}>{runner.name}</span>
                  </td>
                  <td>
                    <RunnerStatus status={runner.status} busy={runner.busy} />
                  </td>
                  <td className={styles.os}>{runner.os}</td>
                  <td>
                    <RunnerLabels labels={runner.labels} />
                  </td>
                  <td className={styles.runnerId}>{runner.id}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className={styles.noResults}>
                  {searchQuery ? `No runners found matching "${searchQuery}"` : "No runners found"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
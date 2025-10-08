import useSWR from "swr";
import styles from "./AutorevertBanner.module.css";

interface AutorevertDetails {
  commit_sha: string;
  workflows: string[];
  source_signal_keys: string[];
  job_ids: number[];
  job_base_names: string[];
  wf_run_ids: number[];
  created_at: string;
}

interface SignalInfo {
  workflow_name: string;
  signals: Array<{
    key: string;
    job_url?: string;
    hud_url?: string;
  }>;
}

export function AutorevertBanner({
  repoOwner,
  repoName,
  sha,
}: {
  repoOwner: string;
  repoName: string;
  sha: string;
}) {
  const { data: autorevertData, error } = useSWR<AutorevertDetails>(
    `/api/autorevert/${repoOwner}/${repoName}/${sha}`,
    async (url) => {
      try {
        const response = await fetch(url);

        if (response.status === 404) {
          // No autorevert data for this commit
          return null;
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to fetch: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        return data;
      } catch (e) {
        // Silently fail - no autorevert data
        return null;
      }
    },
    {
      refreshInterval: 0, // Don't refresh autorevert data
    }
  );

  // Don't show banner if no data or error
  if (!autorevertData) {
    return null;
  }

  // Handle case where arrays might be undefined or have different structure
  const workflows = autorevertData.workflows || [];
  const sourceSignalKeys = autorevertData.source_signal_keys || [];

  // If no workflows data, don't show the banner
  if (!workflows.length) {
    return null;
  }

  // Group signals by workflow
  const signalsByWorkflow = new Map<string, SignalInfo>();

  workflows.forEach((workflow, idx) => {
    if (!signalsByWorkflow.has(workflow)) {
      signalsByWorkflow.set(workflow, {
        workflow_name: workflow,
        signals: [],
      });
    }

    const signalKey = sourceSignalKeys[idx] || "";

    const signal = {
      key: signalKey,
      // Since we don't have job IDs in the table, we can't create direct job links
      job_url: undefined,
      // Try to create a HUD URL using the signal key as a filter
      hud_url: signalKey
        ? `/hud/${repoOwner}/${repoName}/main?nameFilter=${encodeURIComponent(
            signalKey
          )}`
        : undefined,
    };

    signalsByWorkflow.get(workflow)!.signals.push(signal);
  });

  return (
    <div className={styles.autorevertBanner}>
      <div className={styles.bannerHeader}>
        <span className={styles.warningIcon}>⚠️</span>
        <strong>This commit was automatically reverted</strong>
      </div>
      <div className={styles.bannerContent}>
        <p>This PR is attributed to have caused regression in:</p>
        <ul className={styles.workflowList}>
          {Array.from(signalsByWorkflow.values()).map((workflowInfo) => (
            <li key={workflowInfo.workflow_name}>
              <strong>{workflowInfo.workflow_name}:</strong>{" "}
              {workflowInfo.signals.map((signal, idx) => (
                <span key={idx}>
                  {idx > 0 && ", "}
                  <span>{signal.key}</span>
                </span>
              ))}
            </li>
          ))}
        </ul>
        <p className={styles.investigateMessage}>
          You can add the label <code>autorevert: disable</code> to disable
          autorevert for a specific PR.
        </p>
      </div>
    </div>
  );
}

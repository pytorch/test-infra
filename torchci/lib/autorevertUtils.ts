import { JobData, RowData } from "./types";

/**
 * Checks if a job triggered an autorevert by matching against the autorevert workflows and signals
 * @param job The job to check
 * @param rowData The row data containing autorevert information
 * @returns true if the job triggered an autorevert, false otherwise
 */
export function isJobAutorevertSignal(
  job: JobData | { name: string; conclusion?: string },
  rowData: RowData
): boolean {
  if (!rowData.autorevertWorkflows || !rowData.autorevertSignals) {
    return false;
  }

  if (job.conclusion?.toLowerCase() !== "failure") {
    return false;
  }

  const lowAutorevertWorkflows = rowData.autorevertWorkflows.map((w) =>
    w.toLowerCase()
  );

  const jobFullName = job.name;
  if (!jobFullName) {
    return false;
  }

  const parts = jobFullName
    .toLocaleLowerCase()
    .split("/")
    .map((p) =>
      p
        .trim()
        .replace(/ \(.*\)$/, "")
        .trim()
    );
  const jobWorkflow = parts[0];
  const jobNameOnly = parts.slice(1);

  if (!lowAutorevertWorkflows.includes(jobWorkflow)) {
    return false;
  }

  return rowData.autorevertSignals.some((signal) => {
    const signalLower = signal
      .toLowerCase()
      .split("/")
      .map((p) => p.trim());
    return jobNameOnly.every((p, idx) => p == signalLower[idx]);
  });
}

/**
 * Checks if a group contains any jobs that triggered an autorevert
 * @param groupJobs The jobs in the group
 * @param rowData The row data containing autorevert information
 * @returns true if any job in the group triggered an autorevert, false otherwise
 */
export function isGroupAutorevertSignal(
  groupJobs: JobData[],
  rowData: RowData
): boolean {
  return groupJobs.some((job) => isJobAutorevertSignal(job, rowData));
}

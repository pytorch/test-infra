import { JobData, RowData } from "./types";

/**
 * Checks if a job triggered an autorevert by matching against the autorevert workflows and signals
 * @param job The job to check
 * @param rowData The row data containing autorevert information
 * @returns true if the job triggered an autorevert, false otherwise
 */
export function isJobAutorevertSignal(
  job: JobData | { name: string },
  rowData: RowData
): boolean {
  if (!rowData.autorevertWorkflows || !rowData.autorevertSignals) {
    return false;
  }

  const jobFullName = job.name;
  if (!jobFullName) {
    return false;
  }

  // Extract workflow name and job name from full name (format is "Workflow / Job Name")
  const parts = jobFullName.split(" / ");
  const jobWorkflow = parts[0];
  const jobNameOnly = parts.slice(1).join(" / "); // Handle cases with multiple '/'

  // Check if this job's workflow is in the list of workflows that triggered autorevert
  if (!rowData.autorevertWorkflows.includes(jobWorkflow)) {
    return false;
  }

  // Check if this specific job is mentioned in the signals
  return rowData.autorevertSignals.some((signal) => {
    // Signal key is either a test name or a job base name
    // For jobs like "Lint / lintrunner-noclang / linux-job", the base name
    // might be "lintrunner-noclang / linux-job" or just "lintrunner-noclang"

    // Normalize for comparison
    const signalLower = signal.toLowerCase().trim();
    const jobNameLower = jobNameOnly.toLowerCase().trim();

    // Check exact match first
    if (signalLower === jobNameLower) {
      return true;
    }

    // Check if the signal matches the job name without shard suffix
    // (e.g., "lintrunner-noclang" matches "lintrunner-noclang / linux-job")
    const jobBaseParts = jobNameLower.split(" / ");
    if (jobBaseParts.length > 1) {
      const jobBaseOnly = jobBaseParts[0];
      if (signalLower === jobBaseOnly) {
        return true;
      }
    }

    // Also try matching if signal is the complete job name
    return jobNameLower === signalLower;
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

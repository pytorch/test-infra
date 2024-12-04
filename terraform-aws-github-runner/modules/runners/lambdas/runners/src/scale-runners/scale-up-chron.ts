import axios from 'axios';

import { Config } from './config';

export async function scaleUpChron(): Promise<void> {
  // This function does the following:
  // 1. Queries for queued runners via HUD
  // 2. Polls scale-config to filter the list to ones that are self-hosted by this fleet and
  //    are ephemeral
  // 3. Sends a SQS request to the scale-up lambda to provision more of those instances


}

class QueuedJobsForRunner {
  runner_label: string;
  org: string;
  full_repo: string;
  num_queued_jobs: number;
  min_queue_time_min: number;
  max_queue_time_min: number;

  constructor(runner_label: string, org: string, full_repo: string, num_queued_jobs: number, min_queue_time_min: number, max_queue_time_min: number) {
    this.runner_label = runner_label;
    this.org = org;
    this.full_repo = full_repo;
    this.num_queued_jobs = num_queued_jobs;
    this.min_queue_time_min = min_queue_time_min;
    this.max_queue_time_min = max_queue_time_min;
  }
}

export async function getQueuedJobs(): Promise<QueuedJobsForRunner[]> {
  // This function queries the HUD for queued runners
  // and returns a list of them

  const url = 'https://hud.pytorch.org/api/clickhouse/queued_jobs_aggregate?parameters=%5B%5D';

  try {
    const response = await axios.get(url);

    // Map the response to the class
    const queued_runners = response.data.map((runner: any) => {
      return new QueuedJobsForRunner(
        runner.runner_label,
        runner.org,
        runner.full_repo,
        runner.num_queued_jobs,
        runner.min_queue_time_min,
        runner.max_queue_time_min);
    });
    return queued_runners;
  } catch (error) {
    console.error('Error fetching queued runners:', error);
    return [];
  }
}

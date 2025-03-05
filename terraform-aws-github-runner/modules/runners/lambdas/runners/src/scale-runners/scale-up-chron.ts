import axios from 'axios';

import { Config } from './config';
import { getRepo, shuffleArrayInPlace } from './utils';
import { ScaleUpChronMetrics } from './metrics';
import { getRunnerTypes } from './gh-runners';
import { sqsSendMessages } from './sqs';
import { ActionRequestMessage, scaleUp} from './scale-up';
import { randomUUID } from 'crypto';

export async function scaleUpChron(metrics: ScaleUpChronMetrics): Promise<void> {
  // This function does the following:
  // 1. Queries for queued runners via HUD
  // 2. Polls scale-config to filter the list to ones that are self-hosted by this fleet and
  //    are ephemeral
  // 3. Sends a SQS request to the scale-up lambda to provision more of those instances

  let queuedJobs = await getQueuedJobs(metrics);

  const scaleConfigRepo = getRepo(Config.Instance.scaleConfigOrg, Config.Instance.scaleConfigRepo);


  const validRunnerTypes = await getRunnerTypes(scaleConfigRepo, metrics);

  const minAutoScaleupDelayMinutes = 30;
  // Only proactively scale up the jobs that have been queued for longer than normal
  queuedJobs = queuedJobs.filter((runner) => {
    return runner.min_queue_time_minutes >= minAutoScaleupDelayMinutes &&
      runner.org === Config.Instance.scaleConfigOrg;
  });

  // Filter out the queued jobs that are do not correspond to a valid runner type
  queuedJobs = queuedJobs.filter((requested_runner) => {
    return Array.from(validRunnerTypes.keys()).some((available_runner_label) => {
      return available_runner_label === requested_runner.runner_label;
    });
  });

  // Send a message to the SQS queue to scale up the runners
  let scaleUpRequests : Array<ActionRequestMessage> = queuedJobs.map((runner) => {
    return {
      "id": Math.floor(Math.random() * 100000000000000),
      "eventType": "workflow_job",
      "repositoryName": runner.repo,
      "repositoryOwner": runner.org,
      "runnerLabels": [runner.runner_label],
    };
  });

  if (!Config.Instance.scaleUpRecordQueueUrl) {
    throw new Error('scaleUpRecordQueueUrl is not set. Cannot send scale up requests');
  }

  for (const request of shuffleArrayInPlace(scaleUpRequests)) {
    try{
      await scaleUp("aws:sqs", request, metrics);
      metrics.scaleUpChronSuccess();

    } catch (error) {
      metrics.scaleUpChronFailure((error as Error).message);
    }

}

class QueuedJobsForRunner {
  runner_label: string;
  org: string;
  repo: string;
  num_queued_jobs: number;
  min_queue_time_minutes: number;
  max_queue_time_minutes: number;

  constructor(runner_label: string, org: string, repo: string, num_queued_jobs: number, min_queue_time_minutes: number, max_queue_time_minutes: number) {
    this.runner_label = runner_label;
    this.org = org;
    this.repo = repo;
    this.num_queued_jobs = num_queued_jobs;
    this.min_queue_time_minutes = min_queue_time_minutes;
    this.max_queue_time_minutes = max_queue_time_minutes;
  }
}

export async function getQueuedJobs(metrics: ScaleUpChronMetrics): Promise<QueuedJobsForRunner[]> {
  // This function queries the HUD for queued runners
  // and returns a list of them

  const url = 'https://hud.pytorch.org/api/clickhouse/queued_jobs_aggregate?parameters=%5B%5D';

  try {
    const response = await axios.get(url);

    // Map the response to the class
    const queued_runners = response.data.map((runner: any) => {
      metrics.queuedRunnerStats(runner.org, runner.runner_label, runner.num_queued_jobs,);
      return new QueuedJobsForRunner(
        runner.runner_label,
        runner.org,
        runner.repo,
        runner.num_queued_jobs,
        runner.min_queue_time_minutes,
        runner.max_queue_time_minutes);
    });
    return queued_runners;
  } catch (error) {
    metrics.queuedRunnerFailure((error as Error).message);
    console.error('Error fetching queued runners:', error);
    return [];
  }
}

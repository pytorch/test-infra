import axios, { AxiosResponse } from 'axios';

import { Config } from './config';
import { getRepo, shuffleArrayInPlace, expBackOff } from './utils';
import { ScaleUpChronMetrics } from './metrics';
import { getRunnerTypes } from './gh-runners';
import { ActionRequestMessage, scaleUp } from './scale-up';

export async function scaleUpChron(metrics: ScaleUpChronMetrics): Promise<void> {
  // This function does the following:
  // 1. Queries for queued runners via HUD
  // 2. Polls scale-config to filter the list to ones that are self-hosted by this fleet and
  //    are ephemeral and nonephemeral
  // 3. For each runner queued for longer than the minimum delay, try to scale it up

  const scaleConfigRepo = getRepo(Config.Instance.scaleConfigOrg, Config.Instance.scaleConfigRepo);

  const validRunnerTypes = await getRunnerTypes(scaleConfigRepo, metrics, Config.Instance.scaleConfigRepoPath);

  const minAutoScaleupDelayMinutes = Config.Instance.scaleUpMinQueueTimeMinutes;
  if (!Config.Instance.scaleUpChronRecordQueueUrl) {
    metrics.scaleUpInstanceFailureNonRetryable(
      'scaleUpChronRecordQueueUrl is not set. Cannot send queued scale up requests',
    );
    throw new Error('scaleUpChronRecordQueueUrl is not set. Cannot send queued scale up requests');
  }
  const scaleUpChronRecordQueueUrl = Config.Instance.scaleUpChronRecordQueueUrl;
  // Only proactively scale up the jobs that have been queued for longer than normal
  // Filter out the queued jobs that are do not correspond to a valid runner type
  const queuedJobs = (await getQueuedJobs(metrics, scaleUpChronRecordQueueUrl))
    .filter((runner) => {
      return (
        runner.min_queue_time_minutes >= minAutoScaleupDelayMinutes && runner.org === Config.Instance.scaleConfigOrg
      );
    })
    .filter((requested_runner) => {
      return Array.from(validRunnerTypes.keys()).some((available_runner_label) => {
        return available_runner_label === requested_runner.runner_label;
      });
    });

  if (queuedJobs.length === 0) {
    metrics.scaleUpInstanceNoOp();
    return;
  }

  // Send a message to the SQS queue to scale up the runners
  const scaleUpRequests: Array<ActionRequestMessage> = queuedJobs.flatMap((runner) => {
    return new Array(runner.num_queued_jobs).fill({
      id: Math.floor(Math.random() * 100000000000000),
      eventType: 'workflow_job',
      repositoryName: runner.repo,
      repositoryOwner: runner.org,
      runnerLabels: [runner.runner_label],
    });
  });

  for (const request of shuffleArrayInPlace(scaleUpRequests)) {
    try {
      await scaleUp('aws:sqs', request, metrics);
      metrics.scaleUpInstanceSuccess();
    } catch (error) {
      metrics.scaleUpInstanceFailureRetryable((error as Error).message);
    }
  }
}

interface QueuedJobsForRunner {
  runner_label: string;
  org: string;
  repo: string;
  num_queued_jobs: number;
  min_queue_time_minutes: number;
  max_queue_time_minutes: number;
}

export async function getQueuedJobs(
  metrics: ScaleUpChronMetrics,
  scaleUpChronRecordQueueUrl: string,
): Promise<QueuedJobsForRunner[]> {
  // This function queries the HUD for queued runners
  // and returns a list of them

  const url = scaleUpChronRecordQueueUrl;

  try {
    const response = await expBackOff(() => {
      return metrics.trackRequest(metrics.getQueuedJobsEndpointSuccess, metrics.getQueuedJobsEndpointFailure, () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return axios.get<any, AxiosResponse<string>>(url);
      });
    });

    // Map the response to the class
    if (response && response.data) {
      // check if data is valid as QueuedJobsForRunner[]
      if (response.data && Array.isArray(response.data)) {
        return response.data.filter(
          (runner) =>
            runner.runner_label &&
            runner.org &&
            runner.repo &&
            typeof runner.num_queued_jobs == 'number' &&
            runner.num_queued_jobs > 0 &&
            typeof runner.min_queue_time_minutes == 'number' &&
            typeof runner.max_queue_time_minutes == 'number',
        );
      } else {
        /* istanbul ignore next */
        throw new Error(`Invalid data returned from axios get request with url: ${url} - Not an array`);
      }
    } else {
      throw new Error(`No data returned from axios get request with url: ${url}`);
    }
  } catch (error) {
    metrics.queuedRunnerFailure((error as Error).message);
    console.error('Error fetching queued runners:', error);
    return [];
  }
}

import axios from 'axios';

import { Config } from './config';
import { getRepo, shuffleArrayInPlace, expBackOff } from './utils';
import { ScaleUpChronMetrics } from './metrics';
import { getRunnerTypes } from './gh-runners';
import { sqsSendMessages } from './sqs';
import { ActionRequestMessage, scaleUp} from './scale-up';
import { randomUUID } from 'crypto';

export async function scaleUpChron(metrics: ScaleUpChronMetrics): Promise<void> {
  // This function does the following:
  // 1. Queries for queued runners via HUD
  // 2. Polls scale-config to filter the list to ones that are self-hosted by this fleet and
  //    are ephemeral and nonephemeral
  // 3. Sends a SQS request to the scale-up lambda to provision more of those instances
  let queuedJobs = await getQueuedJobs();

  const scaleConfigRepo = getRepo(Config.Instance.scaleConfigOrg, Config.Instance.scaleConfigRepo);

  const scaleConfigRepo = getRepo(Config.Instance.scaleConfigOrg, Config.Instance.scaleConfigRepo);

  const metrics = new ScaleUpChronMetrics();
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

  await sqsSendMessages(metrics, scaleUpRequests, Config.Instance.scaleUpRecordQueueUrl);
}

  const minAutoScaleupDelayMinutes = Config.Instance.scaleUpMinQueueTimeMinutes;
  if (!Config.Instance.scaleUpRecordQueueUrl) {
    metrics.scaleUpInstanceFailureNonRetryable('scaleUpRecordQueueUrl is not set. Cannot send queued scale up requests');
    throw new Error('scaleUpRecordQueueUrl is not set. Cannot send queued scale up requests');
  }
  const scaleUpRecordQueueUrl = Config.Instance.scaleUpRecordQueueUrl;
  // Only proactively scale up the jobs that have been queued for longer than normal
  // Filter out the queued jobs that are do not correspond to a valid runner type
  const queuedJobs = (await getQueuedJobs(metrics, scaleUpRecordQueueUrl)).filter((runner) => {
    return runner.min_queue_time_minutes >= minAutoScaleupDelayMinutes &&
      runner.org === Config.Instance.scaleConfigOrg;
  }).filter((requested_runner) => {
    return Array.from(validRunnerTypes.keys()).some((available_runner_label) => {
      return available_runner_label === requested_runner.runner_label;
    });
  });;

  if (queuedJobs.length === 0) {
    metrics.scaleUpInstanceNoOp();
    return
  }

  // Send a message to the SQS queue to scale up the runners
  const scaleUpRequests : Array<ActionRequestMessage> = queuedJobs.map((runner) => {
    return {
      "id": Math.floor(Math.random() * 100000000000000),
      "eventType": "workflow_job",
      "repositoryName": runner.repo,
      "repositoryOwner": runner.org,
      "runnerLabels": [runner.runner_label],
    };
  });

  for (const request of shuffleArrayInPlace(scaleUpRequests)) {
    try{
      await scaleUp("aws:sqs", request, metrics);
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

export async function getQueuedJobs(metrics: ScaleUpChronMetrics, scaleUpRecordQueueUrl: string): Promise<QueuedJobsForRunner[]> {
  // This function queries the HUD for queued runners
  // and returns a list of them

  const url = scaleUpRecordQueueUrl;

  try {
    const response = await expBackOff(() => {
      return metrics.trackRequest(metrics.getQueuedJobsEndpointSuccess, metrics.getQueuedJobsEndpointFailure, () => {
        return axios.get(url);
      });
    });

    // Map the response to the class
    const responseData = JSON.parse(response.data);
    return responseData.map((runner: any) => {
      metrics.queuedRunnerStats(runner.org, runner.runner_label, runner.num_queued_jobs,);
      return {
        runner_label: runner.runner_label,
        org: runner.org,
        repo: runner.repo,
        num_queued_jobs: Number(runner.num_queued_jobs),
        min_queue_time_minutes: Number(runner.min_queue_time_minutes),
        max_queue_time_minutes: Number(runner.max_queue_time_minutes)
      };
    });
  } catch (error) {
    metrics.queuedRunnerFailure((error as Error).message);
    console.error('Error fetching queued runners:', error);
    return [];
  }
}

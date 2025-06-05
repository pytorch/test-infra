import { Config } from './config';
import { getRunnerTypes } from './gh-runners';
import { ScaleUpMetrics } from './metrics';
import { getRunner } from './runner-utils';
import { RunnerInputParameters, tryRefreshRunner } from './runners';
import { createRunnerConfigArgument, innerCreateRunnerConfigArgument } from './scale-up';
import { getRepoKey, Repo, RunnerInfo } from './utils';

export interface ActionRequestMessage {
  id: number;
  instanceId: string;
  awsRegion: string;
  retryCount?: number;
  delaySeconds?: number;
}

class RetryableEphPostJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableEphPostJobErrorr';
  }
}

export async function EphPostJob(
  eventSource: string,
  payload: ActionRequestMessage,
  metrics: ScaleUpMetrics,
): Promise<void> {
  if (eventSource !== 'aws:sqs') {
    throw new Error('Cannot handle non-SQS events!');
  }

  const { instanceId, awsRegion } = payload;
  if (!instanceId || !awsRegion) {
    console.warn(
      `[Skip] Missing required field(s):${!instanceId ? ' instanceId' : ''}${!awsRegion ? ' awsRegion' : ''}`,
    );
    return;
  }

  let runner: RunnerInfo | undefined;
  try {
    runner = await getRunner(metrics, instanceId, awsRegion);
    if (!runner) {
      console.error(`Runner not found in aws: instanceId=${instanceId}, region=${awsRegion}`);
      //  retryable error
      return;
    }
  } catch (e) {
    // non-retryable error
    console.error(`Failed to get runner: ${e}`);
    return;
  }

  if (!runner.repositoryName || !runner.repositoryOwner || !runner.runnerType) {
    console.error(`Missing required field(s):
        ${!runner.repositoryName ? ' repositoryName' : ''}
        ${!runner.repositoryOwner ? ' repositoryOwner' : ''}
        ${!runner.runnerType ? ' repositoryOwner' : ''}
      `);
    // non-retryable errorm it's missing it's missing.
    return;
  }

  const repo: Repo = { owner: runner.repositoryOwner, repo: runner.repositoryName };
  const runnerTypeMap = await getRunnerTypes(repo, metrics, awsRegion);
  const runnerType = runnerTypeMap.get(runner.runnerType);

  if (!runnerType) {
    console.error(`Can not fetch the runnerType from getRunnerTypes() method`);
    // retryable error
    return;
  }

  const params: RunnerInputParameters = {
    environment: Config.Instance.environment,
    runnerConfig: (awsRegion: string, experimentalRunner: boolean) => {
      return createRunnerConfigArgument(runnerType, repo, undefined, metrics, awsRegion, experimentalRunner);
    },
    runnerType: runnerType,
    repositoryOwner: repo.owner,
    repositoryName: repo.repo,
  };
  try {
    await tryRefreshRunner(params, metrics, runner);
    console.debug(`Refreshed runner: instanceId=${instanceId}, region=${awsRegion}`);
  } catch (e) {
    console.error(`Error refreshing runner: ${e}`);
  }
}

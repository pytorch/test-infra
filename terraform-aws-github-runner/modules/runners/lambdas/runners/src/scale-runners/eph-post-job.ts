import { Config } from './config';
import { getRunnerTypes } from './gh-runners';
import { Metrics, ScaleUpMetrics } from './metrics';
import { getRunner } from './runner-utils';
import { RunnerInputParameters, tryRefreshRunner } from './runners';
import { createRunnerConfigArgument } from './scale-up';
import {
  logAndThrow,
  Repo,
  RunnerInfo,
  RunnerNotFoundError,
  RunnerTypeNotFoundError,
  RunnerValueError,
  ValueError
} from './utils';

export interface EphPostJobMessage {
  id: number;
  instanceId: string;
  awsRegion: string;
  retryCount?: number;
  delaySeconds?: number;
}

export class RetryableEphPostJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableEphPostJobError';
  }
}

/**
 *
 * @param eventSource
 * @param payload
 * @param metrics
 * @returns
 */
export async function ephPostJob(
  eventSource: string,
  payload: EphPostJobMessage,
  metrics: ScaleUpMetrics,
): Promise<void> {

  if (eventSource !== 'aws:sqs') {
    logAndThrow('Cannot handle non-SQS events!');
  }

  const { instanceId, awsRegion } = payload;

  if (!instanceId || !awsRegion) {
    logAndThrow(
      `Missing required field(s) from message:${!instanceId ? ' instanceId' : ''}${!awsRegion ? ' awsRegion' : ''}`,
      ValueError
    );
  }

  console.debug(
    `Received request to refresh runner ${instanceId} in ${awsRegion}.` +
    ` Retry attempt: ${payload.retryCount ?? 0}`
  );

  try {

    console.debug('Attempting to retrieve runner information...');
    const runner = await fetchEc2RunnerInfo(metrics, instanceId, awsRegion);
    const repo: Repo = { owner: runner.repositoryOwner, repo: runner.repositoryName };
    const runnerType = await fetchRunnerType(runner.runnerType, repo, awsRegion, metrics);

    const orgScope = runner.org;
    const repoScope = runner.repo;

    console.debug('Attempting to form the paramter for method tryRefreshRunner...');
    const params: RunnerInputParameters = {
      runnerConfig: (awsRegion: string, experimentalRunner: boolean) => {
        return createRunnerConfigArgument(runnerType, repo, undefined, metrics, awsRegion, experimentalRunner);
      },
      environment: Config.Instance.environment,
      runnerType: runnerType,
      repositoryOwner: repo.owner,
      repositoryName: repo.repo,
      repoName: repoScope,
      orgName:  orgScope,
    };

    console.debug('Attempting to refresh the runner...');
    await tryRefreshRunner(params, metrics, runner);
    console.debug(`Successfully trigger refreshing with runner: instanceId=${instanceId}, region=${awsRegion}`);
  } catch (e) {
    if (e instanceof RunnerNotFoundError) {
      logAndThrow(e.message, RetryableEphPostJobError);
    }
    throw e;
  }
}

  /**
   * Attempts to retrieve a EC2 runner instance by its ID and region,
   * and performs validation to ensure it has all required metadata fields.
   *
   * Required fields:
   * - `repositoryName`,`repositoryOwner`, and`runnerType` must be non-empty strings.
   * -   At least one of `org` or `repo` tags must be defined.
   *
   * If any required information is missing or the runner cannot be fetched, the function
   * logs and throw an appropriate error.
   *
   * @param metrics - Metrics collector used to track fetch or validation behavior.
   * @param instanceId - The EC2 instance ID for the runner.
   * @param awsRegion - AWS region where the instance is located.
   * @returns A validated `RunnerInfo` object with required fields guaranteed, or throw error.
   */
async function fetchEc2RunnerInfo(
  metrics: Metrics,
  instanceId: string,
  awsRegion: string,
): Promise<
  RunnerInfo & {
    repositoryName: string;
    repositoryOwner: string;
    runnerType: string;
  }
> {
  const runner = await getRunner(metrics, instanceId, awsRegion);
  if (!runner) {
    logAndThrow('(fetchValidRunner) Runner is undefined', RunnerNotFoundError);
  }
  assertValidRunnerInfo(runner, '(fetchValidRunner)');
  return runner;
}

/**
 * Validates a runner object and throws if required fields are missing.
 */
function assertValidRunnerInfo(
  runner: RunnerInfo,
  context?: string,
): asserts runner is RunnerInfo & {
  repositoryName: string;
  repositoryOwner: string;
  runnerType: string;
} {
  const missingFields = [
    !runner.repositoryName && 'repositoryName',
    !runner.repositoryOwner && 'repositoryOwner',
    !runner.runnerType && 'runnerType',
    !runner.repo && !runner.org && 'repo/org',
  ].filter(Boolean);

  if (missingFields.length > 0) {
    logAndThrow(`${context ?? ''} Missing required fields: ${missingFields.join(', ')}`, RunnerValueError);
  }

  if (!hasAtLeastOneOrgField(runner)) {
    logAndThrow(`${context ?? ''} Missing both repo and org, must have at least one`, RunnerNotFoundError);
  }
}

async function fetchRunnerType(
  key: string,
  repo: Repo,
  awsRegion: string,
  metrics: Metrics,
) {
  const runnerTypeMap = await getRunnerTypes(repo, metrics, awsRegion);
  const runnerType = runnerTypeMap.get(key);
  if (!runnerType) {
    logAndThrow(`Can not fetch the runnerType ${key} from getRunnerTypes() method`, RunnerTypeNotFoundError);
  }
  return runnerType;
}

function hasAtLeastOneOrgField(runner: RunnerInfo): boolean {
  return Boolean(runner.repo?.trim() || runner.org?.trim());
}

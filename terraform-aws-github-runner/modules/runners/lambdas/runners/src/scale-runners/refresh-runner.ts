import { Config } from './config';
import { getRunnerTypes } from './gh-runners';
import { ScaleUpMetrics } from './metrics';
import { getRunner, RunnerInputParameters } from './runners';
import { innerCreateRunnerConfigArgument } from './scale-up';
import { tryRefreshRunner } from './scale-up-try-reuse-runner-utils';
import { getRepoKey, Repo, RunnerInfo } from './utils';

export interface ActionRequestMessage {
  id: number;
  instanceId: string;
  awsRegion: string;
}

class RetryableRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableRefreshError';
  }
}

export async function refreshRunner(
    eventSource: string,
    payload: ActionRequestMessage,
    metrics: ScaleUpMetrics,
  ): Promise<void> {
    if (eventSource !== 'aws:sqs') {
      throw new Error('Cannot handle non-SQS events!');
    }

    const { instanceId, awsRegion } = payload;
    if (!instanceId || !awsRegion) {
      console.warn(`[Skip] Missing required field(s):${!instanceId ? ' instanceId' : ''}${!awsRegion ? ' awsRegion' : ''}`);
      return;
    }

    console.debug(`Refreshing runner: instanceId=${instanceId}, region=${awsRegion}`);

    let runner: RunnerInfo | undefined;
    try {
      runner = await getRunner(metrics, instanceId, awsRegion);
      if (!runner) {
        console.warn(`Runner not found in aws: instanceId=${instanceId}, region=${awsRegion}`);
        return;
      }
    } catch (e) {
      console.error(`Failed to get runner: ${e}`);
      return;
    }

    const { runnerType: runnerTypeName, repositoryOwner, repositoryName, org, repo } = runner;
    if (!runnerTypeName || !repositoryOwner || !repositoryName) {
      console.warn(`[Skip] Missing runner metadata: ${JSON.stringify({ runnerTypeName, repositoryOwner, repositoryName })}`);
      return;
    }

    if (!org && !repo) {
      console.warn(`Runner is missing both org and repo: instanceId=${instanceId}`);
      return;
    }

    const isOrgRunner = !!org;
    const isEphemeral = true;
    const ghesUrlHost = Config.Instance.ghesUrlHost;
    const repoInfo: Repo = { owner: repositoryOwner, repo: repositoryName };

    console.debug(`Fetching runner type for: ${runnerTypeName}`);
    const runnerTypes = await getRunnerTypes(repoInfo, metrics, awsRegion);
    const runnerType = runnerTypes.get(runnerTypeName);

    if (!runnerType) {
      console.warn(`Runner type not found: ${runnerTypeName}`);
      return;
    }

    const createRunnerParams: RunnerInputParameters = {
      environment: Config.Instance.environment,
      runnerConfig: (awsRegion: string, experimentalRunner: boolean) =>
        innerCreateRunnerConfigArgument(
          runnerTypeName,
          repositoryName,
          repositoryOwner,
          awsRegion,
          metrics,
          ghesUrlHost,
          isOrgRunner,
          isEphemeral,
          experimentalRunner,
          runner.runnerExtraLabels,
          runner.runnerTypeLabels,
          runner.runnerGroupName,
        ),
      runnerType,
      repositoryOwner,
      repositoryName,
      ...(Config.Instance.enableOrganizationRunners
        ? { orgName: repositoryOwner }
        : { repoName: getRepoKey(repoInfo) }),
    };

    try {
      await tryRefreshRunner(createRunnerParams, metrics, runner);
      console.debug(`Refreshed runner: instanceId=${instanceId}, region=${awsRegion}`);
    } catch (e) {
      console.error(`Error refreshing runner: ${e}`);
    }
  }

import { Metrics, ScaleUpMetrics } from './metrics';
import { Repo, getRepoKey } from './utils';
import { RunnerType, RunnerInputParameters, createRunner } from './runners';
import {
  createRegistrationTokenOrg,
  createRegistrationTokenRepo,
  getRunnerTypes,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
  getGitHubRateLimit,
} from './gh-runners';

import { Config } from './config';
import { getRepoIssuesWithLabel } from './gh-issues';

export interface ActionRequestMessage {
  id: number;
  eventType: string;
  repositoryName: string;
  repositoryOwner: string;
  installationId?: number;
  runnerLabels?: string[];
  retryCount?: number;
  delaySeconds?: number;
}

export class RetryableScalingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableScalingError';
  }
}

export async function scaleUp(
  eventSource: string,
  payload: ActionRequestMessage,
  metrics: ScaleUpMetrics,
): Promise<void> {
  if (eventSource !== 'aws:sqs') {
    throw Error('Cannot handle non-SQS events!');
  }

  const repo: Repo = {
    owner: payload.repositoryOwner,
    repo: payload.repositoryName,
  };

  const errors = [];

  if (await shouldSkipForRepo(repo, metrics)) {
    metrics.skipRepo(repo);
    return;
  }

  metrics.runRepo(repo);
  metrics.run();

  try {
    const ghLimitInfo = await getGitHubRateLimit(repo, metrics);
    metrics.gitHubRateLimitStats(ghLimitInfo.limit, ghLimitInfo.remaining, ghLimitInfo.used);
  } catch (e) {
    /* istanbul ignore next */
    console.error(`Error getting GitHub rate limit: ${e}`);
  }

  const scaleConfigRepo = {
    owner: repo.owner,
    repo: Config.Instance.scaleConfigRepo || repo.repo,
  };
  const runnerTypes = await getRunnerTypes(scaleConfigRepo, metrics);
  /* istanbul ignore next */
  const runnerLabels = payload?.runnerLabels ?? Array.from(runnerTypes.keys());

  // ideally we should only have one label specfied but loop so we can go through them all if there are multiple
  // if no labels are found this should just be a no-op
  for (const runnerLabel of runnerLabels) {
    const runnerType = runnerTypes.get(runnerLabel);
    if (runnerType === undefined) {
      console.info(
        `Runner label '${runnerLabel}' was not found in config at ` +
          `${scaleConfigRepo.owner}/${scaleConfigRepo.repo}/${Config.Instance.scaleConfigRepoPath}`,
      );
      continue;
    }
    const runnersRequested = 1;
    const runnersToCreate = await getCreatableRunnerCount(
      runnerType.runnerTypeName,
      repo,
      runnerType.is_ephemeral,
      runnerType.max_available,
      runnersRequested,
      metrics,
    );
    for (let i = 0; i < runnersToCreate; i++) {
      try {
        const createRunnerParams: RunnerInputParameters = {
          environment: Config.Instance.environment,
          runnerConfig: (awsRegion: string, experimentalRunner: boolean) => {
            return createRunnerConfigArgument(
              runnerType,
              repo,
              payload.installationId,
              metrics,
              awsRegion,
              experimentalRunner,
            );
          },
          runnerType: runnerType,
        };
        if (Config.Instance.enableOrganizationRunners) {
          createRunnerParams.orgName = repo.owner;
        } else {
          createRunnerParams.repoName = getRepoKey(repo);
        }
        const awsRegion = await createRunner(createRunnerParams, metrics);
        if (Config.Instance.enableOrganizationRunners) {
          metrics.runnersOrgCreate(repo.owner, runnerType.runnerTypeName, awsRegion);
        } else {
          metrics.runnersRepoCreate(repo, runnerType.runnerTypeName, awsRegion);
        }
      } catch (e) {
        errors.push(e);

        /* istanbul ignore next */
        if (Config.Instance.enableOrganizationRunners) {
          metrics.runnersOrgCreateFail(repo.owner, runnerType.runnerTypeName);
        } else {
          metrics.runnersRepoCreateFail(repo, runnerType.runnerTypeName);
        }
        /* istanbul ignore next */
        console.error(`Error spinning up instance of type ${runnerType.runnerTypeName}: ${e}`);
      }
    }
    if (!runnersToCreate) {
      console.info('There are available runners, no new runners will be created');
    }
  }

  if (errors.length > 0) {
    const msg =
      `Thrown ${errors.length} exceptions during scaleup when creating runners, ` +
      'will fail this batch so it can be retried';
    console.warn(msg);
    throw new RetryableScalingError(msg);
  }
}

async function createRunnerConfigArgument(
  runnerType: RunnerType,
  repo: Repo,
  installationId: number | undefined,
  metrics: Metrics,
  awsRegion: string,
  experimentalRunner: boolean,
): Promise<string> {
  const ephemeralArgument = runnerType.is_ephemeral || experimentalRunner ? '--ephemeral' : '';
  const labelsArgument = [
    `AWS:${awsRegion}`,
    `${runnerType.runnerTypeName}`,
    ...(experimentalRunner ? ['experimental.ami'] : []),
    ...(Config.Instance.runnersExtraLabels ? Config.Instance.runnersExtraLabels.split(',') : []),
    ...(runnerType.labels ?? []),
  ].join(',');

  if (Config.Instance.enableOrganizationRunners) {
    /* istanbul ignore next */
    const runnerGroupArgument =
      Config.Instance.runnerGroupName !== undefined ? `--runnergroup ${Config.Instance.runnerGroupName}` : '';
    const token = await createRegistrationTokenOrg(repo.owner, metrics, installationId);
    return (
      `--url ${Config.Instance.ghesUrlHost}/${repo.owner} ` +
      `--token ${token} --labels ${labelsArgument} ${ephemeralArgument} ${runnerGroupArgument}`
    );
  } else {
    const token = await createRegistrationTokenRepo(repo, metrics, installationId);
    return (
      `--url ${Config.Instance.ghesUrlHost}/${repo.owner}/${repo.repo} ` +
      `--token ${token} --labels ${labelsArgument} ${ephemeralArgument}`
    );
  }
}

async function shouldSkipForRepo(repo: Repo, metrics: Metrics): Promise<boolean> {
  if (Config.Instance.mustHaveIssuesLabels) {
    for (let i = 0; i < Config.Instance.mustHaveIssuesLabels.length; i++) {
      const label = Config.Instance.mustHaveIssuesLabels[i];
      if ((await getRepoIssuesWithLabel(repo, label, metrics)).length == 0) {
        console.warn(
          `Skipping scaleUp for repo '${repo.owner}/${repo.repo}' as a issue with label ` +
            `'${label}' is required to be open but is not present`,
        );
        return true;
      }
    }
  }

  for (let i = 0; i < Config.Instance.cantHaveIssuesLabels.length; i++) {
    const label = Config.Instance.cantHaveIssuesLabels[i];
    if ((await getRepoIssuesWithLabel(repo, label, metrics)).length > 0) {
      console.warn(
        `Skipping scaleUp for repo '${repo.owner}/${repo.repo}' as a open issue ` +
          `with label '${label}' must not be present`,
      );
      return true;
    }
  }

  return false;
}

/**
 *  Returns the number of runners that should be created to process the given request
 */
async function getCreatableRunnerCount(
  runnerType: string,
  repo: Repo,
  isEphemeral: boolean,
  maxAvailable: number | undefined,
  requestedCount: number,
  metrics: ScaleUpMetrics,
): Promise<number> {
  const ghRunners = Config.Instance.enableOrganizationRunners
    ? await listGithubRunnersOrg(repo.owner, metrics)
    : await listGithubRunnersRepo(repo, metrics);

  const runnersWithLabel = ghRunners.filter(
    (x) => x.labels.some((y) => y.name === runnerType) && x.status.toLowerCase() !== 'offline',
  );
  const busyCount = runnersWithLabel.filter((x) => x.busy).length;
  console.info(
    `Found matching GitHub runners [${runnerType}], ${busyCount}/` +
      `${runnersWithLabel.length}/${ghRunners.length} are busy`,
  );

  if (Config.Instance.enableOrganizationRunners) {
    metrics.ghRunnersOrgStats(repo.owner, runnerType, runnersWithLabel.length, runnersWithLabel.length, busyCount);
  } else {
    metrics.ghRunnersRepoStats(repo, runnerType, runnersWithLabel.length, runnersWithLabel.length, busyCount);
  }

  const maxScaleUp = getMaximumAllowedScaleUpSize(maxAvailable, runnersWithLabel.length, isEphemeral);

  if (maxScaleUp <= 0) {
    /* istanbul ignore next */
    if (Config.Instance.enableOrganizationRunners) {
      metrics.ghRunnersOrgMaxHit(repo.owner, runnerType);
    } else {
      metrics.ghRunnersRepoMaxHit(repo, runnerType);
    }

    console.info(
      `Max runners hit [${runnerType}], ${busyCount}/${runnersWithLabel.length}/${ghRunners.length} - Limit enforced`,
    );

    return 0;
  }

  const availableCount = runnersWithLabel.length - busyCount;
  const minRunners = Config.Instance.minAvailableRunners > 0 ? Config.Instance.minAvailableRunners : 1;

  const scaleUpAmount = _calculateScaleUpAmount(requestedCount, isEphemeral, minRunners, maxScaleUp, availableCount);
  return scaleUpAmount;
}

/**
 * Returns the maximum number of runners that can be created for the given runner type
 */
function getMaximumAllowedScaleUpSize(
  maxAllowed: number | undefined,
  provisioned: number,
  isEphemeral: boolean,
): number {
  const NO_LIMIT = Number.MAX_SAFE_INTEGER;

  if (isEphemeral) {
    // Ephemeral runners are not limited by maxAllowed
    return NO_LIMIT;
  }

  if (maxAllowed === undefined || maxAllowed <= 0) {
    return NO_LIMIT;
  }

  return maxAllowed - provisioned;
}

/**
 * Returns the number of runners that should be created to process the given request
 *
 * Note: exported only for testing
 *
 * The desired logic for scale ups is as follows:
 *   - Always stay below the maximum allowed instance count for the runner type
 *   - If the in coming request will bring us belo than minimum number of runners available,
 *     overprovision by a bit to bring us closer to the minimum limit (to handle potential
 *     incoming traffic).
 *   - Only provision more runners if supporting the requested number of runners would
 *     bring us below the minimum available limit
 * @param requestedCount
 * @param isEphemeral
 * @param minRunners
 * @param maxScaleUp - Maximum additional runners that can be provisioned
 * @param availableCount
 */
export function _calculateScaleUpAmount(
  requestedCount: number,
  isEphemeral: boolean,
  minRunners: number, // Minimum number of runners that should be available
  maxScaleUp: number,
  availableCount: number, // Number of runners that are currently available to run jobs
): number {
  const availableAfterAcceptingRequests = Math.max(availableCount - requestedCount, 0);
  const extraNeededToAcceptRequests = Math.max(requestedCount - availableCount, 0);

  // Tracks how many runners should be provisioned to bring us up to the minimum limit
  const minRunnersUnderprovisionCount = minRunners - availableAfterAcceptingRequests;

  let extraScaleUp = 0;
  if (minRunnersUnderprovisionCount > 0) {
    // Scale up by a bit extra to bring us closer to the minimum limit

    // Keep the overprovisioning to a small % when we have a large number of runners requested
    extraScaleUp = Math.ceil(minRunnersUnderprovisionCount * 0.05);

    if (isEphemeral) {
      // We randomly overprovision ephemeral runners to handle extra incoming requests.
      // This is to compensate for requests that fail to provision runners for unknown reasons.
      // We're more aggressive here since these runners are short lived and cannot be reused.

      const overprovisionFrequency = 0.5; // Overprovision 50% of the time
      const overprovisionAmount = 2; // Additional runners to add when overprovisioning

      if (Math.random() < overprovisionFrequency) {
        extraScaleUp += overprovisionAmount;
      }
    }

    // Never proactively scale up above the minimum limit
    extraScaleUp = Math.min(extraScaleUp, minRunnersUnderprovisionCount);

    console.info(
      `Available (${availableCount}) runners will be below minimum ${minRunners}. ` +
        `Will provision ${extraScaleUp} extra runners`,
    );
  }

  let scaleUpAmount = extraNeededToAcceptRequests + extraScaleUp;
  if (scaleUpAmount > maxScaleUp) {
    console.info(
      `Desired count ${scaleUpAmount} is higher than max allowed scale up ${maxScaleUp}, ` +
        `will scale up ${maxScaleUp} instead`,
    );

    scaleUpAmount = maxScaleUp;
  }

  return scaleUpAmount;
}

import moment from 'moment';
import { Config } from './config';
import { resetSecretCache } from './gh-auth';
import {
  getRunnerOrg,
  getRunnerRepo,
  getRunnerTypes,
  GhRunner,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
  removeGithubRunnerOrg,
  removeGithubRunnerRepo,
  resetGHRunnersCaches,
} from './gh-runners';
import { ScaleDownMetrics, sendMetricsAtTimeout, sendMetricsTimeoutVars } from './metrics';
import { doDeleteSSMParameter, listRunners, listSSMParameters, resetRunnersCaches, terminateRunner } from './runners';
import { getRepo, groupBy, Repo, RunnerInfo, isGHRateLimitError, shuffleArrayInPlace } from './utils';
import { SSM } from 'aws-sdk';

// Add caching for GitHub runners to reduce API calls
export const ghRunnerCache = new Map<string, { data: GhRunner[]; timestamp: number; ttl: number }>();
const CACHE_TTL_MS = 30000; // 30 seconds cache

async function getCachedGHRunnersOrg(org: string, metrics: ScaleDownMetrics): Promise<GhRunner[]> {
  const cacheKey = `org-${org}`;
  const cached = ghRunnerCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    console.debug(`Using cached GitHub runners for org: ${org}`);
    return cached.data;
  }

  try {
    const runners = await listGithubRunnersOrg(org, metrics);
    ghRunnerCache.set(cacheKey, {
      data: runners,
      timestamp: Date.now(),
      ttl: CACHE_TTL_MS,
    });
    return runners;
  } catch (e) {
    console.warn(`Failed to list GitHub runners for org ${org}`, e);
    // Return cached data if available, even if expired
    if (cached) {
      console.debug(`Returning expired cache for org: ${org}`);
      return cached.data;
    }
    throw e;
  }
}

async function getCachedGHRunnersRepo(repo: Repo, metrics: ScaleDownMetrics): Promise<GhRunner[]> {
  const cacheKey = `repo-${repo.owner}-${repo.repo}`;
  const cached = ghRunnerCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    console.debug(`Using cached GitHub runners for repo: ${repo.owner}/${repo.repo}`);
    return cached.data;
  }

  try {
    const runners = await listGithubRunnersRepo(repo, metrics);
    ghRunnerCache.set(cacheKey, {
      data: runners,
      timestamp: Date.now(),
      ttl: CACHE_TTL_MS,
    });
    return runners;
  } catch (e) {
    console.warn(`Failed to list GitHub runners for repo ${repo.owner}/${repo.repo}`, e);
    // Return cached data if available, even if expired
    if (cached) {
      console.debug(`Returning expired cache for repo: ${repo.owner}/${repo.repo}`);
      return cached.data;
    }
    throw e;
  }
}

export async function scaleDown(): Promise<void> {
  const metrics = new ScaleDownMetrics();
  const sndMetricsTimout: sendMetricsTimeoutVars = {
    metrics: metrics,
  };
  sndMetricsTimout.setTimeout = setTimeout(
    sendMetricsAtTimeout(sndMetricsTimout),
    (Config.Instance.lambdaTimeout - 10) * 1000,
  );

  // Track execution time for early timeout detection
  const startTime = Date.now();
  const getElapsedSeconds = () => Math.floor((Date.now() - startTime) / 1000);
  const timeoutThreshold = Config.Instance.lambdaTimeout - 15; // Leave 15s buffer (reduced from 30s)
  const isTestEnvironment = process.env.NODE_ENV === 'test';

  // Helper function for timeout detection
  const isApproachingTimeout = () => !isTestEnvironment && getElapsedSeconds() > timeoutThreshold;

  // Helper function to add removable runner to appropriate array
  const addRemovableRunner = (
    ec2runner: RunnerInfo,
    ghRunner: GhRunner | undefined,
    ghRunnersRemovableNoGHRunner: Array<[RunnerInfo, GhRunner | undefined]>,
    ghRunnersRemovableWGHRunner: Array<[RunnerInfo, GhRunner]>
  ) => {
    if (ghRunner === undefined) {
      ghRunnersRemovableNoGHRunner.push([ec2runner, undefined]);
    } else {
      ghRunnersRemovableWGHRunner.push([ec2runner, ghRunner]);
    }
  };

  try {
    console.info('Scale down started');
    // Ensure a clean cache before attempting each scale down event
    resetRunnersCaches();
    await resetGHRunnersCaches();
    resetSecretCache();

    metrics.run();

    const runnersDict = groupBy(
      sortRunnersByLaunchTime(await listRunners(metrics, { environment: Config.Instance.environment })),
      (itm) => {
        if (Config.Instance.enableOrganizationRunners) return itm.runnerType;
        return `${itm.runnerType}#${itm.repo}`;
      },
    );

    const runnersRegions = new Set<string>(
      Array.from(runnersDict.values()).flatMap((runners) => runners.map((runner) => runner.awsRegion)),
    );

    if (runnersDict.size === 0) {
      console.debug(`No active runners found for environment: '${Config.Instance.environment}'`);
      return;
    }

      // Early timeout check after initial setup (skip in test environment)
  if (!isTestEnvironment && getElapsedSeconds() > timeoutThreshold * 0.2) {
    console.warn(`Early timeout detection: ${getElapsedSeconds()}s elapsed, reducing scope`);
  }

    const foundOrgs = new Set<string>();
    const foundRepos = new Set<string>();

    // Process runner groups in parallel with controlled concurrency
    const maxConcurrency = Math.min(10, runnersDict.size); // Limit to avoid overwhelming APIs
    const runnerEntries = shuffleArrayInPlace(Array.from(runnersDict.entries()));

    // Process runner groups in batches for better performance
    const batchSize = Math.max(1, Math.floor(runnerEntries.length / maxConcurrency));
    const batches = [];
    for (let i = 0; i < runnerEntries.length; i += batchSize) {
      batches.push(runnerEntries.slice(i, i + batchSize));
    }

    await Promise.all(
      batches.map(async (batch) => {
        for (const [runnerType, runners] of batch) {
          // Early timeout check during processing (skip in test environment)
          if (isApproachingTimeout()) {
            console.warn(`Timeout approaching (${getElapsedSeconds()}s), skipping remaining runners in batch`);
            break;
          }

          if (runners.length < 1 || runners[0].runnerType === undefined || runnerType === undefined) continue;

          const ghRunnersRemovableWGHRunner: Array<[RunnerInfo, GhRunner]> = [];
          const ghRunnersRemovableNoGHRunner: Array<[RunnerInfo, GhRunner | undefined]> = [];

          // Process runners in parallel within each group
          const runnerPromises = runners.map(async (ec2runner) => {
            // REPO assigned runners
            if (ec2runner.repo !== undefined) {
              foundRepos.add(ec2runner.repo);
              const ghRunner = await getGHRunnerRepo(ec2runner, metrics);
              // if configured to repo, don't mess with organization runners
              if (!Config.Instance.enableOrganizationRunners) {
                metrics.runnerFound(ec2runner);
                if (await isRunnerRemovable(ghRunner, ec2runner, metrics)) {
                  addRemovableRunner(ec2runner, ghRunner, ghRunnersRemovableNoGHRunner, ghRunnersRemovableWGHRunner);
                }
              }
              // ORG assigned runners
            } else if (ec2runner.org !== undefined) {
              foundOrgs.add(ec2runner.org);
              const ghRunner = await getGHRunnerOrg(ec2runner, metrics);
              // if configured to org, don't mess with repo runners
              if (Config.Instance.enableOrganizationRunners) {
                metrics.runnerFound(ec2runner);
                if (await isRunnerRemovable(ghRunner, ec2runner, metrics)) {
                  addRemovableRunner(ec2runner, ghRunner, ghRunnersRemovableNoGHRunner, ghRunnersRemovableWGHRunner);
                }
              }
            } else {
              // This is mostly designed to send metrics and statistics for pet instances that don't have clear
              // ownership.
              metrics.runnerFound(ec2runner);
            }
          });

          // Wait for all runners in this group to be processed
          await Promise.allSettled(runnerPromises);

          const ghRunnersRemovable: Array<[RunnerInfo, GhRunner | undefined]> =
            ghRunnersRemovableNoGHRunner.concat(ghRunnersRemovableWGHRunner);

          // Process removals in parallel with controlled concurrency
          const removalPromises = [];
          let removedRunners = 0;

          for (const [ec2runner, ghRunner] of ghRunnersRemovable) {
            // Early timeout check during removals (skip in test environment)
            if (isApproachingTimeout()) {
              console.warn(`Timeout approaching (${getElapsedSeconds()}s), stopping removals`);
              break;
            }

            // We only limit the number of removed instances here for the reason: while sorting and getting info
            // on getRunner[Org|Repo] we send statistics that are relevant for monitoring
            if (
              ghRunnersRemovable.length - removedRunners <= (await minRunners(ec2runner, metrics)) &&
              ghRunner !== undefined &&
              ec2runner.applicationDeployDatetime == Config.Instance.datetimeDeploy
            ) {
              continue;
            }

            const removalPromise = processRunnerRemoval(ec2runner, ghRunner, metrics);
            removalPromises.push(removalPromise);
            removedRunners += 1;

            // Limit concurrent removals to avoid overwhelming APIs
            if (removalPromises.length >= 5) {
              await Promise.allSettled(removalPromises.splice(0, 5));
            }
          }

          // Process remaining removals
          if (removalPromises.length > 0) {
            await Promise.allSettled(removalPromises);
          }
        }
      }),
    );

    // Only proceed with cleanup if we have time remaining (always proceed in test environment)
    if (isTestEnvironment || getElapsedSeconds() < timeoutThreshold) {
      // Process offline runners cleanup in parallel
      const offlineCleanupPromises = [];

      if (Config.Instance.enableOrganizationRunners) {
        for (const org of foundOrgs) {
          offlineCleanupPromises.push(cleanupOfflineRunnersOrg(org, metrics));
        }
      } else {
        for (const repoString of foundRepos) {
          offlineCleanupPromises.push(cleanupOfflineRunnersRepo(repoString, metrics));
        }
      }

      // Run offline cleanup and SSM cleanup in parallel
      await Promise.all([Promise.allSettled(offlineCleanupPromises), cleanupOldSSMParameters(runnersRegions, metrics)]);
    } else {
      console.warn(`Skipping cleanup operations due to time constraints (${getElapsedSeconds()}s elapsed)`);
    }

    console.info(`Scale down completed in ${getElapsedSeconds()}s`);
  } catch (e) {
    /* istanbul ignore next */
    metrics.exception();
    /* istanbul ignore next */
    throw e;
  } finally {
    clearTimeout(sndMetricsTimout.setTimeout);
    sndMetricsTimout.metrics = undefined;
    sndMetricsTimout.setTimeout = undefined;
    await metrics.sendMetrics();
  }
}

// Helper function to process individual runner removal
async function processRunnerRemoval(
  ec2runner: RunnerInfo,
  ghRunner: GhRunner | undefined,
  metrics: ScaleDownMetrics,
): Promise<void> {
  let shouldRemoveEC2 = true;

  if (ghRunner !== undefined) {
    if (Config.Instance.enableOrganizationRunners) {
      console.debug(
        `GH Runner instance '${ghRunner.id}'[${ec2runner.org}] for EC2 '${ec2runner.instanceId}' ` +
          `[${ec2runner.runnerType}] will be removed.`,
      );
      try {
        await removeGithubRunnerOrg(ghRunner.id, ec2runner.org as string, metrics);
        metrics.runnerGhTerminateSuccessOrg(ec2runner.org as string, ec2runner);
        console.info(
          `GH Runner instance '${ghRunner.id}'[${ec2runner.org}] for EC2 '${ec2runner.instanceId}' ` +
            `[${ec2runner.runnerType}] successfuly removed.`,
        );
      } catch (e) {
        /* istanbul ignore next */
        console.warn(
          `GH Runner instance '${ghRunner.id}'[${ec2runner.org}] for EC2 '${ec2runner.instanceId}' ` +
            `[${ec2runner.runnerType}] failed to be removed. ${e}`,
        );
        /* istanbul ignore next */
        metrics.runnerGhTerminateFailureOrg(ec2runner.org as string, ec2runner);
        /* istanbul ignore next */
        shouldRemoveEC2 = false;
      }
    } else {
      const repo = getRepo(ec2runner.repo as string);
      console.debug(
        `GH Runner instance '${ghRunner.id}'[${ec2runner.repo}] for EC2 '${ec2runner.instanceId}' ` +
          `[${ec2runner.runnerType}] will be removed.`,
      );
      try {
        await removeGithubRunnerRepo(ghRunner.id, repo, metrics);
        metrics.runnerGhTerminateSuccessRepo(repo, ec2runner);
        console.info(
          `GH Runner instance '${ghRunner.id}'[${ec2runner.repo}] for EC2 '${ec2runner.instanceId}' ` +
            `[${ec2runner.runnerType}] successfuly removed.`,
        );
      } catch (e) {
        /* istanbul ignore next */
        console.warn(
          `GH Runner instance '${ghRunner.id}'[${ec2runner.repo}] for EC2 '${ec2runner.instanceId}' ` +
            `[${ec2runner.runnerType}] failed to be removed. ${e}`,
        );
        /* istanbul ignore next */
        metrics.runnerGhTerminateFailureRepo(repo, ec2runner);
        /* istanbul ignore next */
        shouldRemoveEC2 = false;
      }
    }
  } else {
    if (Config.Instance.enableOrganizationRunners) {
      metrics.runnerGhTerminateNotFoundOrg(ec2runner.org as string, ec2runner);
    } else {
      metrics.runnerGhTerminateFailureRepo(getRepo(ec2runner.repo as string), ec2runner);
    }
  }

  if (shouldRemoveEC2) {
    console.info(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] will be removed.`);
    try {
      await terminateRunner(ec2runner, metrics);
      metrics.runnerTerminateSuccess(ec2runner);
    } catch (e) {
      /* istanbul ignore next */
      metrics.runnerTerminateFailure(ec2runner);
      /* istanbul ignore next */
      console.error(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] cannot be removed: ${e}`);
    }
  } else {
    /* istanbul ignore next */
    metrics.runnerTerminateSkipped(ec2runner);
  }
}

// Helper function to cleanup offline runners for organizations
async function cleanupOfflineRunnersOrg(org: string, metrics: ScaleDownMetrics): Promise<void> {
  try {
    const offlineGhRunners = (await getCachedGHRunnersOrg(org, metrics)).filter(
      (r) => r.status.toLowerCase() === 'offline',
    );
    metrics.runnerGhOfflineFoundOrg(org, offlineGhRunners.length);

    // Process offline runner removals in parallel
    const removalPromises = offlineGhRunners.map(async (ghRunner) => {
      try {
        await removeGithubRunnerOrg(ghRunner.id, org, metrics);
        metrics.runnerGhOfflineRemovedOrg(org);
      } catch (e) {
        /* istanbul ignore next */
        console.warn(`Failed to remove offline runner ${ghRunner.id} for org ${org}`, e);
        /* istanbul ignore next */
        metrics.runnerGhOfflineRemovedFailureOrg(org);
      }
    });

    await Promise.allSettled(removalPromises);
  } catch (e) {
    console.warn(`Failed to cleanup offline runners for org ${org}`, e);
  }
}

// Helper function to cleanup offline runners for repositories
async function cleanupOfflineRunnersRepo(repoString: string, metrics: ScaleDownMetrics): Promise<void> {
  try {
    const repo = getRepo(repoString);
    const offlineGhRunners = (await getCachedGHRunnersRepo(repo, metrics)).filter(
      (r) => r.status.toLowerCase() === 'offline',
    );
    metrics.runnerGhOfflineFoundRepo(repo, offlineGhRunners.length);

    // Process offline runner removals in parallel
    const removalPromises = offlineGhRunners.map(async (ghRunner) => {
      try {
        await removeGithubRunnerRepo(ghRunner.id, repo, metrics);
        metrics.runnerGhOfflineRemovedRepo(repo);
      } catch (e) {
        /* istanbul ignore next */
        console.warn(`Failed to remove offline runner ${ghRunner.id} for repo ${repo}`, e);
        /* istanbul ignore next */
        metrics.runnerGhOfflineRemovedFailureRepo(repo);
      }
    });

    await Promise.allSettled(removalPromises);
  } catch (e) {
    console.warn(`Failed to cleanup offline runners for repo ${repoString}`, e);
  }
}

export async function cleanupOldSSMParameters(runnersRegions: Set<string>, metrics: ScaleDownMetrics): Promise<void> {
  try {
    // Process regions in parallel
    const regionPromises = Array.from(runnersRegions).map(async (awsRegion) => {
      try {
        const ssmParams = sortSSMParametersByUpdateTime(
          Array.from((await listSSMParameters(metrics, awsRegion)).values()),
        );

        let deleted = 0;
        const deletionPromises = [];

        for (const ssmParam of ssmParams) {
          /* istanbul ignore next */
          if (ssmParam.Name === undefined) {
            continue;
          }
          if (ssmParam.LastModifiedDate === undefined) {
            break;
          }
          if (
            ssmParam.LastModifiedDate.getTime() >
            moment().subtract(Config.Instance.sSMParamCleanupAgeDays, 'days').toDate().getTime()
          ) {
            break;
          }

          // Process deletions in parallel batches
          const deletionPromise = doDeleteSSMParameter(ssmParam.Name, metrics, awsRegion).then((success) => {
            if (success) deleted += 1;
            return success;
          });
          deletionPromises.push(deletionPromise);

          // Process in batches of 5 to avoid overwhelming SSM API
          if (deletionPromises.length >= 5) {
            await Promise.allSettled(deletionPromises.splice(0, 5));
          }

          if (deleted >= Config.Instance.sSMParamMaxCleanupAllowance) {
            break;
          }
        }

        // Process remaining deletions
        if (deletionPromises.length > 0) {
          await Promise.allSettled(deletionPromises);
        }

        if (deleted > 0) {
          console.info(`Deleted ${deleted} old SSM parameters in ${awsRegion}`);
        }
      } catch (e) {
        console.warn(`Failed to cleanup SSM parameters in region ${awsRegion}`, e);
      }
    });

    await Promise.allSettled(regionPromises);
  } catch (e) {
    /* istanbul ignore next */
    console.error('Failed to cleanup old SSM parameters', e);
  }
}

export async function getGHRunnerOrg(ec2runner: RunnerInfo, metrics: ScaleDownMetrics): Promise<GhRunner | undefined> {
  const org = ec2runner.org as string;
  let ghRunner: GhRunner | undefined = undefined;

  try {
    const ghRunners = await getCachedGHRunnersOrg(org, metrics);
    ghRunner = ghRunners.find((runner) => runner.name === ec2runner.instanceId);
  } catch (e) {
    console.warn('Failed to list active gh runners', e);
    if (isGHRateLimitError(e)) {
      throw e;
    }
  }

  if (ghRunner === undefined && ec2runner.ghRunnerId !== undefined) {
    console.warn(
      `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${org}) not found in ` +
        `listGithubRunnersOrg call, attempting to grab directly`,
    );
    try {
      ghRunner = await getRunnerOrg(ec2runner.org as string, ec2runner.ghRunnerId, metrics);
    } catch (e) {
      console.warn(
        `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${org}) error when ` +
          `listGithubRunnersOrg call: ${e}`,
      );
      /* istanbul ignore next */
      if (isGHRateLimitError(e)) {
        throw e;
      }
    }
  }
  if (ghRunner) {
    if (ghRunner.busy) {
      metrics.runnerGhFoundBusyOrg(org, ec2runner);
    } else {
      metrics.runnerGhFoundNonBusyOrg(org, ec2runner);
    }
  } else {
    metrics.runnerGhNotFoundOrg(org, ec2runner);
  }
  return ghRunner;
}

export async function getGHRunnerRepo(ec2runner: RunnerInfo, metrics: ScaleDownMetrics): Promise<GhRunner | undefined> {
  const repo = getRepo(ec2runner.repo as string);
  let ghRunner: GhRunner | undefined = undefined;

  try {
    const ghRunners = await getCachedGHRunnersRepo(repo, metrics);
    ghRunner = ghRunners.find((runner) => runner.name === ec2runner.instanceId);
  } catch (e) {
    console.warn('Failed to list active gh runners', e);
    /* istanbul ignore next */
    if (isGHRateLimitError(e)) {
      throw e;
    }
  }

  if (ghRunner === undefined) {
    if (ec2runner.ghRunnerId === undefined) {
      console.warn(
        `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${repo}) was neither found in ` +
          `the list of runners returned by the listGithubRunnersRepo api call, nor did it have the ` +
          `GithubRunnerId EC2 tag set.  This can happen if there's no runner running on the instance.`,
      );
    } else {
      console.warn(
        `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${repo}) not found in ` +
          `listGithubRunnersRepo call, attempting to grab directly`,
      );
      try {
        ghRunner = await getRunnerRepo(repo, ec2runner.ghRunnerId, metrics);
      } catch (e) {
        console.warn(
          `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${repo}) error when getRunnerRepo call: ${e}`,
        );
        /* istanbul ignore next */
        if (isGHRateLimitError(e)) {
          throw e;
        }
      }
    }
  }
  if (ghRunner !== undefined) {
    if (ghRunner.busy) {
      metrics.runnerGhFoundBusyRepo(repo, ec2runner);
    } else {
      metrics.runnerGhFoundNonBusyRepo(repo, ec2runner);
    }
  } else {
    metrics.runnerGhNotFoundRepo(repo, ec2runner);
  }
  return ghRunner;
}

export async function isEphemeralRunner(ec2runner: RunnerInfo, metrics: ScaleDownMetrics): Promise<boolean> {
  if (ec2runner.runnerType === undefined) {
    return false;
  }

  const repo: Repo = (() => {
    if (Config.Instance.scaleConfigRepo) {
      return {
        owner: ec2runner.org !== undefined ? (ec2runner.org as string) : getRepo(ec2runner.repo as string).owner,
        repo: Config.Instance.scaleConfigRepo,
      };
    }
    return getRepo(ec2runner.repo as string);
  })();

  const runnerTypes = await getRunnerTypes(repo, metrics);

  return runnerTypes.get(ec2runner.runnerType)?.is_ephemeral ?? false;
}

export async function minRunners(ec2runner: RunnerInfo, metrics: ScaleDownMetrics): Promise<number> {
  if (ec2runner.runnerType === undefined) {
    /* istanbul ignore next */
    return Config.Instance.minAvailableRunners;
  }

  const repo: Repo = (() => {
    if (Config.Instance.scaleConfigRepo) {
      return {
        owner: ec2runner.org !== undefined ? (ec2runner.org as string) : getRepo(ec2runner.repo as string).owner,
        repo: Config.Instance.scaleConfigRepo,
      };
    }
    return getRepo(ec2runner.repo as string);
  })();

  const runnerTypes = await getRunnerTypes(repo, metrics);

  return runnerTypes.get(ec2runner.runnerType)?.min_available ?? Config.Instance.minAvailableRunners;
}

export async function isRunnerRemovable(
  ghRunner: GhRunner | undefined,
  ec2runner: RunnerInfo,
  metrics: ScaleDownMetrics,
): Promise<boolean> {
  /* istanbul ignore next */
  if (ec2runner.instanceManagement?.toLowerCase() === 'pet') {
    console.debug(`Runner ${ec2runner.instanceId} is a pet instance and cannot be removed.`);
    return false;
  }

  if (ghRunner !== undefined && ghRunner.busy) {
    console.debug(`Runner ${ec2runner.instanceId} is busy and cannot be removed.`);
    return false;
  }

  if (!runnerMinimumTimeExceeded(ec2runner)) {
    console.debug(`Runner ${ec2runner.instanceId} has not exceeded the minimum running time.`);
    metrics.runnerLessMinimumTime(ec2runner);
    return false;
  }

  if (ghRunner === undefined) {
    console.debug(`Runner ${ec2runner.instanceId} was not found on GitHub. It might not be running an agent`);
  }

  console.debug(`Runner ${ec2runner.instanceId} is removable.`);
  metrics.runnerIsRemovable(ec2runner);
  return true;
}

/**
 * Determines if the runner has been provisioned for at least the minimum running time configured.
 * This is used to allow runners to stay idle for a certain amount of time in case they pick up
 * extra jobs, and to avoid the case where a runner is provisioned and then immediately scaled down.
 * The limit gives us some buffer room while avoiding unnecessary costs.
 */
export function runnerMinimumTimeExceeded(runner: RunnerInfo): boolean {
  let baseTime: moment.Moment;
  let reason: string;
  if (runner.ebsVolumeReplacementRequestTimestamp !== undefined) {
    // When both `ebsVolumeReplacementRequestTimestamp` and `ephemeralRunnerFinished` are defined,
    // we want to use the more recent timestamp to ensure that we don't scale down a runner
    // that is still in the process of being refreshed.
    if (
      runner.ephemeralRunnerFinished !== undefined &&
      runner.ebsVolumeReplacementRequestTimestamp < runner.ephemeralRunnerFinished
    ) {
      baseTime = moment.unix(runner.ephemeralRunnerFinished);
      reason = `is an ephemeral runner that finished at ${baseTime}`;
    } else {
      // Add 5 minutes to the EBS volume replacement request timestamp to account
      // for the time it takes to replace the volume and start the runner.
      baseTime = moment.unix(runner.ebsVolumeReplacementRequestTimestamp).add(5, 'minutes');
      reason = `had an EBS volume replacement request started at ${baseTime}`;
    }
  } else if (runner.ephemeralRunnerFinished !== undefined) {
    baseTime = moment.unix(runner.ephemeralRunnerFinished);
    reason = `is an ephemeral runner that finished at ${baseTime}`;
  } else {
    baseTime = moment(runner.launchTime || new Date()).utc();
    reason = `was launched at ${baseTime}`;
  }

  const maxTime = moment(new Date()).subtract(Config.Instance.minimumRunningTimeInMinutes, 'minutes').utc();
  const minTimeExceeded = baseTime < maxTime;
  if (minTimeExceeded) {
    console.debug(
      `[runnerMinimumTimeExceeded] Instance ${runner.instanceId} ${reason} and has ` +
        `exceeded the minimum running time of ${Config.Instance.minimumRunningTimeInMinutes} mins ` +
        `by ${maxTime.diff(baseTime, 'minutes')} mins.`,
    );
  }

  return minTimeExceeded;
}

export function sortRunnersByLaunchTime(runners: RunnerInfo[]): RunnerInfo[] {
  return runners.sort((a, b): number => {
    if (a.launchTime === undefined && b.launchTime === undefined) return 0;
    if (a.launchTime === undefined) return 1;
    if (b.launchTime === undefined) return -1;
    if (a.launchTime < b.launchTime) return -1;
    if (a.launchTime > b.launchTime) return 1;
    return 0;
  });
}

export function sortSSMParametersByUpdateTime(ssmParams: Array<SSM.ParameterMetadata>): Array<SSM.ParameterMetadata> {
  return ssmParams.sort((a, b): number => {
    if (a.LastModifiedDate === undefined && b.LastModifiedDate === undefined) return 0;
    if (a.LastModifiedDate === undefined) return 1;
    if (b.LastModifiedDate === undefined) return -1;
    if (a.LastModifiedDate < b.LastModifiedDate) return -1;
    if (a.LastModifiedDate > b.LastModifiedDate) return 1;
    return 0;
  });
}

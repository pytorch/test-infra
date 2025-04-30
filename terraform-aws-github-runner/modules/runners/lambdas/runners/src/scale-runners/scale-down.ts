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

export async function scaleDown(): Promise<void> {
  const metrics = new ScaleDownMetrics();
  const sndMetricsTimout: sendMetricsTimeoutVars = {
    metrics: metrics,
  };
  sndMetricsTimout.setTimeout = setTimeout(
    sendMetricsAtTimeout(sndMetricsTimout),
    (Config.Instance.lambdaTimeout - 10) * 1000,
  );

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

    const foundOrgs = new Set<string>();
    const foundRepos = new Set<string>();

    for (const [runnerType, runners] of shuffleArrayInPlace(Array.from(runnersDict.entries()))) {
      if (runners.length < 1 || runners[0].runnerType === undefined || runnerType === undefined) continue;

      const ghRunnersRemovableWGHRunner: Array<[RunnerInfo, GhRunner]> = [];
      const ghRunnersRemovableNoGHRunner: Array<[RunnerInfo, GhRunner | undefined]> = [];

      for (const ec2runner of runners) {
        // REPO assigned runners
        if (ec2runner.repo !== undefined) {
          foundRepos.add(ec2runner.repo);
          const ghRunner = await getGHRunnerRepo(ec2runner, metrics);
          // if configured to repo, don't mess with organization runners
          if (!Config.Instance.enableOrganizationRunners) {
            metrics.runnerFound(ec2runner);
            if (isRunnerRemovable(ghRunner, ec2runner, metrics)) {
              if (ghRunner === undefined) {
                ghRunnersRemovableNoGHRunner.push([ec2runner, undefined]);
              } else {
                ghRunnersRemovableWGHRunner.push([ec2runner, ghRunner]);
              }
            }
          }
          // ORG assigned runners
        } else if (ec2runner.org !== undefined) {
          foundOrgs.add(ec2runner.org);
          const ghRunner = await getGHRunnerOrg(ec2runner, metrics);
          // if configured to org, don't mess with repo runners
          if (Config.Instance.enableOrganizationRunners) {
            metrics.runnerFound(ec2runner);
            if (isRunnerRemovable(ghRunner, ec2runner, metrics)) {
              if (ghRunner === undefined) {
                ghRunnersRemovableNoGHRunner.push([ec2runner, undefined]);
              } else {
                ghRunnersRemovableWGHRunner.push([ec2runner, ghRunner]);
              }
            }
          }
        } else {
          // This is mostly designed to send metrics and statistics for pet instances that don't have clear
          // ownership.
          metrics.runnerFound(ec2runner);
        }
      }

      const ghRunnersRemovable: Array<[RunnerInfo, GhRunner | undefined]> =
        ghRunnersRemovableNoGHRunner.concat(ghRunnersRemovableWGHRunner);

      let removedRunners = 0;
      for (const [ec2runner, ghRunner] of ghRunnersRemovable) {
        // We only limit the number of removed instances here for the reason: while sorting and getting info
        // on getRunner[Org|Repo] we send statistics that are relevant for monitoring
        if (
          ghRunnersRemovable.length - removedRunners <= (await minRunners(ec2runner, metrics)) &&
          ghRunner !== undefined &&
          ec2runner.applicationDeployDatetime == Config.Instance.datetimeDeploy
        ) {
          continue;
        }

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
          removedRunners += 1;

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
    }

    if (Config.Instance.enableOrganizationRunners) {
      for (const org of foundOrgs) {
        const offlineGhRunners = (await listGithubRunnersOrg(org, metrics)).filter(
          (r) => r.status.toLowerCase() === 'offline',
        );
        metrics.runnerGhOfflineFoundOrg(org, offlineGhRunners.length);

        for (const ghRunner of offlineGhRunners) {
          try {
            await removeGithubRunnerOrg(ghRunner.id, org, metrics);
            metrics.runnerGhOfflineRemovedOrg(org);
          } catch (e) {
            /* istanbul ignore next */
            console.warn(`Failed to remove offline runner ${ghRunner.id} for org ${org}`, e);
            /* istanbul ignore next */
            metrics.runnerGhOfflineRemovedFailureOrg(org);
          }
        }
      }
    } else {
      for (const repoString of foundRepos) {
        const repo = getRepo(repoString);
        const offlineGhRunners = (await listGithubRunnersRepo(repo, metrics)).filter(
          (r) => r.status.toLowerCase() === 'offline',
        );
        metrics.runnerGhOfflineFoundRepo(repo, offlineGhRunners.length);

        for (const ghRunner of offlineGhRunners) {
          try {
            await removeGithubRunnerRepo(ghRunner.id, repo, metrics);
            metrics.runnerGhOfflineRemovedRepo(repo);
          } catch (e) {
            /* istanbul ignore next */
            console.warn(`Failed to remove offline runner ${ghRunner.id} for repo ${repo}`, e);
            /* istanbul ignore next */
            metrics.runnerGhOfflineRemovedFailureRepo(repo);
          }
        }
      }
    }

    await cleanupOldSSMParameters(runnersRegions, metrics);

    console.info('Scale down completed');
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

export async function cleanupOldSSMParameters(runnersRegions: Set<string>, metrics: ScaleDownMetrics): Promise<void> {
  try {
    for (const awsRegion of runnersRegions) {
      const ssmParams = sortSSMParametersByUpdateTime(
        Array.from((await listSSMParameters(metrics, awsRegion)).values()),
      );

      let deleted = 0;
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
        if (await doDeleteSSMParameter(ssmParam.Name, metrics, awsRegion)) {
          deleted += 1;
        }
        if (deleted >= Config.Instance.sSMParamMaxCleanupAllowance) {
          break;
        }
      }

      if (deleted > 0) {
        console.info(`Deleted ${deleted} old SSM parameters in ${awsRegion}`);
      }
    }
  } catch (e) {
    /* istanbul ignore next */
    console.error('Failed to cleanup old SSM parameters', e);
  }
}

export async function getGHRunnerOrg(ec2runner: RunnerInfo, metrics: ScaleDownMetrics): Promise<GhRunner | undefined> {
  const org = ec2runner.org as string;
  let ghRunner: GhRunner | undefined = undefined;

  try {
    const ghRunners = await listGithubRunnersOrg(org as string, metrics);
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
    const ghRunners = await listGithubRunnersRepo(repo, metrics);
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

export function isRunnerRemovable(
  ghRunner: GhRunner | undefined,
  ec2runner: RunnerInfo,
  metrics: ScaleDownMetrics,
): boolean {
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
  if (runner.ephemeralRunnerFinished !== undefined) {
    baseTime = moment.unix(runner.ephemeralRunnerFinished);
    reason = `is an ephemeral runner that finished at ${baseTime}`;
  } else if (runner.ebsVolumeReplacementRequestTimestamp !== undefined) {
    baseTime = moment.unix(runner.ebsVolumeReplacementRequestTimestamp);
    reason = `had an EBS volume replacement request started at ${baseTime}`;
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

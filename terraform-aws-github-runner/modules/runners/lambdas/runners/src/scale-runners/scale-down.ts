import {
  GhRunner,
  getRunnerOrg,
  getRunnerRepo,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
  listRunners,
  removeGithubRunnerOrg,
  removeGithubRunnerRepo,
  resetRunnersCaches,
  terminateRunner,
} from './runners';
import { RunnerInfo, getRepo } from './utils';

import { Config } from './config';
import moment from 'moment';
import { resetSecretCache } from './gh-auth';
import { ScaleDownMetrics } from './metrics';

function runnerMinimumTimeExceeded(runner: RunnerInfo): boolean {
  const launchTimePlusMinimum = moment(runner.launchTime)
    .utc()
    .add(Config.Instance.minimumRunningTimeInMinutes, 'minutes');
  const now = moment(new Date()).utc();
  return launchTimePlusMinimum < now;
}

export default async function scaleDown(): Promise<void> {
  // list and sort runners, newest first. This ensure we keep the newest runners longer.
  const metrics = new ScaleDownMetrics();

  try {
    // Ensure a clean cache before attempting each scale down event
    resetRunnersCaches();
    resetSecretCache();

    const runners = (
      await listRunners(metrics, {
        environment: Config.Instance.environment,
      })
    ).sort((a, b): number => {
      if (a.launchTime === undefined && b.launchTime === undefined) return 0;
      if (a.launchTime === undefined) return 1;
      if (b.launchTime === undefined) return 1;
      if (a.launchTime < b.launchTime) return 1;
      if (a.launchTime > b.launchTime) return -1;
      return 0;
    });

    if (runners.length === 0) {
      console.debug(`No active runners found for environment: '${Config.Instance.environment}'`);
      return;
    }

    metrics.run();

    for await (const ec2runner of runners) {
      metrics.runnerFound(ec2runner);

      let nonOrphan = false;
      if (ec2runner.repo !== undefined) {
        nonOrphan = nonOrphan || (await checkNeedRemoveRunnerRepo(ec2runner, metrics));
      }
      if (ec2runner.org !== undefined) {
        nonOrphan = nonOrphan || (await checkNeedRemoveRunnerOrg(ec2runner, metrics));
      }

      // we only check if minimum time exceeded after other stuff even if the checks are
      // not relevant to generate metrics
      if (!runnerMinimumTimeExceeded(ec2runner)) {
        metrics.runnerLessMinimumTime(ec2runner);
        console.debug(
          `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] has not been alive long enough, skipping`,
        );
        continue;
      }

      if (!nonOrphan) {
        // Remove orphan AWS runners.
        console.info(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] is orphaned, and will be removed.`);
        try {
          await terminateRunner(ec2runner, metrics);
          metrics.runnerTerminateSuccess(ec2runner);
        } catch (e) {
          metrics.runnerTerminateFailure(ec2runner);
          console.error(`Orphan runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] cannot be removed: ${e}`);
        }
      }
    }
  } finally {
    metrics.sendMetrics();
  }
}

async function checkNeedRemoveRunnerRepo(ec2runner: RunnerInfo, metrics: ScaleDownMetrics): Promise<boolean> {
  const repo = getRepo(ec2runner.repo as string);
  const ghRunners = await listGithubRunnersRepo(repo, metrics);
  let ghRunner: GhRunner | undefined = ghRunners.find((runner) => runner.name === ec2runner.instanceId);
  if (ghRunner === undefined && ec2runner.ghRunnerId !== undefined) {
    console.warn(
      `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${repo}) not found in ` +
        `listGithubRunnersRepo call, attempting to grab directly`,
    );
    try {
      ghRunner = await getRunnerRepo(repo, ec2runner.ghRunnerId, metrics);
    } catch (e) {
      console.warn(
        `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${repo}) error when ` + `getRunnerRepo call: ${e}`,
      );
      return false;
    }
  }
  // ec2Runner matches a runner that's registered to github
  if (ghRunner) {
    if (ghRunner.busy) {
      metrics.runnerGhFoundBusyRepo(repo, ec2runner);
      console.debug(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${repo}) is busy, skipping`);
    } else {
      metrics.runnerGhFoundNonBusyRepo(repo, ec2runner);
      await removeGithubRunnerRepo(ec2runner, ghRunner.id, repo, metrics);
    }
    return true;
  } else {
    metrics.runnerGhNotFoundRepo(repo, ec2runner);
    return false;
  }
}

async function checkNeedRemoveRunnerOrg(ec2runner: RunnerInfo, metrics: ScaleDownMetrics): Promise<boolean> {
  const org = ec2runner.org as string;
  const ghRunners = await listGithubRunnersOrg(org as string, metrics);
  let ghRunner: GhRunner | undefined = ghRunners.find((runner) => runner.name === ec2runner.instanceId);
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
      return false;
    }
  }
  // ec2Runner matches a runner that's registered to github
  if (ghRunner) {
    if (ghRunner.busy) {
      metrics.runnerGhFoundBusyOrg(org, ec2runner);
      console.debug(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${org}) is busy, skipping`);
    } else {
      metrics.runnerGhFoundNonBusyOrg(org, ec2runner);
      await removeGithubRunnerOrg(ec2runner, ghRunner.id, org, metrics);
    }
    return true;
  } else {
    metrics.runnerGhNotFoundOrg(org, ec2runner);
    return false;
  }
}

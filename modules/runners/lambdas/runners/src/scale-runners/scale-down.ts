import {
  GhRunner,
  RunnerInfo,
  getRepo,
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

import { Config } from './config';
import moment from 'moment';

function runnerMinimumTimeExceeded(runner: RunnerInfo): boolean {
  const launchTimePlusMinimum = moment(runner.launchTime)
    .utc()
    .add(Config.Instance.minimumRunningTimeInMinutes, 'minutes');
  const now = moment(new Date()).utc();
  return launchTimePlusMinimum < now;
}

export default async function scaleDown(): Promise<void> {
  // list and sort runners, newest first. This ensure we keep the newest runners longer.
  const runners = (
    await listRunners({
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

  // Ensure a clean cache before attempting each scale down event
  resetRunnersCaches();

  for await (const ec2runner of runners) {
    if (!runnerMinimumTimeExceeded(ec2runner)) {
      console.debug(
        `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] has not been alive long enough, skipping`,
      );
      continue;
    }

    let nonOrphan = false;
    if (ec2runner.repo !== undefined) {
      nonOrphan = nonOrphan || (await checkNeedRemoveRunnerRepo(ec2runner));
    }
    if (ec2runner.org !== undefined) {
      nonOrphan = nonOrphan || (await checkNeedRemoveRunnerOrg(ec2runner));
    }
    if (!nonOrphan) {
      // Remove orphan AWS runners.
      console.info(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] is orphaned, and will be removed.`);
      try {
        await terminateRunner(ec2runner);
      } catch (e) {
        console.error(`Orphan runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] cannot be removed: ${e}`);
      }
    }
  }
}

async function checkNeedRemoveRunnerRepo(ec2runner: RunnerInfo): Promise<boolean> {
  const repo = getRepo(ec2runner.repo as string);
  const ghRunners = await listGithubRunnersRepo(repo);
  let ghRunner: GhRunner | undefined = ghRunners.find((runner) => runner.name === ec2runner.instanceId);
  if (ghRunner === undefined && ec2runner.ghRunnerId !== undefined) {
    console.warn(
      `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${repo}) not found in ` +
        `listGithubRunnersRepo call, attempting to grab directly`,
    );
    ghRunner = await getRunnerRepo(repo, ec2runner.ghRunnerId);
  }
  // ec2Runner matches a runner that's registered to github
  if (ghRunner) {
    if (ghRunner.busy) {
      console.debug(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${repo}) is busy, skipping`);
    } else {
      await removeGithubRunnerRepo(ec2runner, ghRunner.id, repo);
    }
    return true;
  } else {
    return false;
  }
}

async function checkNeedRemoveRunnerOrg(ec2runner: RunnerInfo): Promise<boolean> {
  const org = ec2runner.org as string;
  const ghRunners = await listGithubRunnersOrg(org as string);
  let ghRunner: GhRunner | undefined = ghRunners.find((runner) => runner.name === ec2runner.instanceId);
  if (ghRunner === undefined && ec2runner.ghRunnerId !== undefined) {
    console.warn(
      `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${org}) not found in ` +
        `listGithubRunnersOrg call, attempting to grab directly`,
    );
    ghRunner = await getRunnerOrg(ec2runner.org as string, ec2runner.ghRunnerId);
  }
  // ec2Runner matches a runner that's registered to github
  if (ghRunner) {
    if (ghRunner.busy) {
      console.debug(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}](${org}) is busy, skipping`);
    } else {
      await removeGithubRunnerOrg(ec2runner, ghRunner.id, org);
    }
    return true;
  } else {
    return false;
  }
}

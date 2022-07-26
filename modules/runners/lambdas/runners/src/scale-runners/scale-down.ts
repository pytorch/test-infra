import {
  GhRunner,
  RunnerInfo,
  getRepo,
  getRunner,
  listGithubRunners,
  listRunners,
  removeGithubRunner,
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

export async function scaleDown(): Promise<void> {
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

    if (ec2runner.repo === undefined) continue;
    const repo = getRepo(ec2runner.repo);
    const ghRunners = await listGithubRunners(repo);
    let ghRunner: GhRunner | undefined = ghRunners.find((runner) => runner.name === ec2runner.instanceId);
    // Github's / Octokit's list for self hosted runners is inconsistent when listing out pages > 1
    // so we attempt to do a sanity check here to make sure that the instance itself is actually
    // orphaned and not busy, the ghRunnerId will only be populated if the runner was actually
    // registered to Github so this should be a fairly safe call to make
    if (ghRunner === undefined && ec2runner.ghRunnerId !== undefined) {
      console.warn(
        `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] not found in ` +
          `listGithubRunners call, attempting to grab directly`,
      );
      ghRunner = await getRunner(repo, ec2runner.ghRunnerId);
    }
    // ec2Runner matches a runner that's registered to github
    if (ghRunner) {
      if (ghRunner.busy) {
        console.debug(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] is busy, skipping`);
        continue;
      } else {
        await removeGithubRunner(ec2runner, ghRunner.id, repo);
      }
    } else {
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

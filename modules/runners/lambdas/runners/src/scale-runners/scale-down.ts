import { Octokit } from '@octokit/rest';
import moment from 'moment';
import {
  listRunners,
  RunnerInfo,
  terminateRunner,
  Repo,
  createGitHubClientForRunner,
  listGithubRunners,
  getRepo,
  ghRunnersCache,
  ghClientCache,
  getRunner,
  GhRunner,
} from './runners';
import { getIdleRunnerCount, ScalingDownConfig } from './scale-down-config';

function runnerMinimumTimeExceeded(runner: RunnerInfo, minimumRunningTimeInMinutes: string): boolean {
  const launchTimePlusMinimum = moment(runner.launchTime).utc().add(minimumRunningTimeInMinutes, 'minutes');
  const now = moment(new Date()).utc();
  return launchTimePlusMinimum < now;
}

async function removeRunner(
  ec2runner: RunnerInfo,
  ghRunnerId: number,
  repo: Repo,
  githubAppClient: Octokit,
): Promise<void> {
  try {
    const result = await githubAppClient.actions.deleteSelfHostedRunnerFromRepo({
      runner_id: ghRunnerId,
      owner: repo.repoOwner,
      repo: repo.repoName,
    });

    if (result.status == 204) {
      await terminateRunner(ec2runner);
      console.info(
        `AWS runner instance '${ec2runner.instanceId}' [${ec2runner.runnerType}] is terminated and GitHub runner is de-registered.`,
      );
    }
  } catch (e) {
    console.warn(`Error scaling down '${ec2runner.instanceId}' [${ec2runner.runnerType}]: ${e}`);
  }
}

export async function scaleDown(): Promise<void> {
  const enableOrgLevel = false;
  const environment = process.env.ENVIRONMENT as string;
  const minimumRunningTimeInMinutes = process.env.MINIMUM_RUNNING_TIME_IN_MINUTES as string;

  // list and sort runners, newest first. This ensure we keep the newest runners longer.
  const runners = (
    await listRunners({
      environment: environment,
    })
  ).sort((a, b): number => {
    if (a.launchTime === undefined) return 1;
    if (b.launchTime === undefined) return 1;
    if (a.launchTime < b.launchTime) return 1;
    if (a.launchTime > b.launchTime) return -1;
    return 0;
  });

  if (runners.length === 0) {
    console.debug(`No active runners found for environment: '${environment}'`);
    return;
  }

  // Ensure a clean cache before attempting each scale down event
  ghRunnersCache.reset();
  ghClientCache.reset();

  for await (const ec2runner of runners) {
    if (!runnerMinimumTimeExceeded(ec2runner, minimumRunningTimeInMinutes)) {
      console.debug(
        `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] has not been alive long enough, skipping`,
      );
      continue;
    }

    const githubAppClient = await createGitHubClientForRunner(ec2runner.org, ec2runner.repo, enableOrgLevel);
    const repo = getRepo(ec2runner.org, ec2runner.repo, enableOrgLevel);
    const ghRunners = await listGithubRunners(githubAppClient, ec2runner.org, ec2runner.repo, enableOrgLevel);
    let ghRunner: GhRunner | undefined = ghRunners.find((runner) => runner.name === ec2runner.instanceId);
    // Github's / Octokit's list for self hosted runners is inconsistent when listing out pages > 1
    // so we attempt to do a sanity check here to make sure that the instance itself is actually
    // orphaned and not busy, the ghRunnerId will only be populated if the runner was actually
    // registered to Github so this should be a fairly safe call to make
    if (ghRunner === undefined && ec2runner.ghRunnerId !== undefined) {
      console.warn(
        `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] not found in listGithubRunners call, attempting to grab directly`,
      );
      ghRunner = await getRunner(githubAppClient, repo.repoOwner, repo.repoName, ec2runner.ghRunnerId);
    }
    // ec2Runner matches a runner that's registered to github
    if (ghRunner) {
      if (ghRunner.busy) {
        console.debug(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] is busy, skipping`);
        continue;
      } else {
        await removeRunner(ec2runner, ghRunner.id, repo, githubAppClient);
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

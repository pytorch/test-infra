import { Octokit } from '@octokit/rest';
import moment from 'moment';
import yn from 'yn';
import { listRunners, RunnerInfo, terminateRunner, Repo, createGitHubClientForRunnerFactory, listGithubRunnersFactory, getRepo } from './runners';
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
  enableOrgLevel: boolean,
  githubAppClient: Octokit,
): Promise<void> {
  try {
    const result = enableOrgLevel
      ? await githubAppClient.actions.deleteSelfHostedRunnerFromOrg({
        runner_id: ghRunnerId,
        org: repo.repoOwner,
      })
      : await githubAppClient.actions.deleteSelfHostedRunnerFromRepo({
        runner_id: ghRunnerId,
        owner: repo.repoOwner,
        repo: repo.repoName,
      });

    if (result.status == 204) {
      await terminateRunner(ec2runner);
      console.info(`AWS runner instance '${ec2runner.instanceId}' is terminated and GitHub runner is de-registered.`);
    }
  } catch (e) {
    console.debug(`Runner '${ec2runner.instanceId}' cannot be de-registered, most likely the runner is active.`);
  }
}

export async function scaleDown(): Promise<void> {
  const scaleDownConfigs = JSON.parse(process.env.SCALE_DOWN_CONFIG as string) as [ScalingDownConfig];

  const enableOrgLevel = yn(process.env.ENABLE_ORGANIZATION_RUNNERS, { default: true });
  const environment = process.env.ENVIRONMENT as string;
  const minimumRunningTimeInMinutes = process.env.MINIMUM_RUNNING_TIME_IN_MINUTES as string;
  let idleCounter = getIdleRunnerCount(scaleDownConfigs);

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

  const createGitHubClientForRunner = createGitHubClientForRunnerFactory();
  const listGithubRunners = listGithubRunnersFactory();

  for (const ec2runner of runners) {
    if (!runnerMinimumTimeExceeded(ec2runner, minimumRunningTimeInMinutes)) {
      continue;
    }

    const githubAppClient = await createGitHubClientForRunner(ec2runner.org, ec2runner.repo, enableOrgLevel);

    const repo = getRepo(ec2runner.org, ec2runner.repo, enableOrgLevel);
    const ghRunners = await listGithubRunners(githubAppClient, ec2runner.org, ec2runner.repo, enableOrgLevel);
    let orphanEc2Runner = true;
    for (const ghRunner of ghRunners) {
      const runnerName = ghRunner.name as string;
      if (runnerName === ec2runner.instanceId) {
        orphanEc2Runner = false;
        if (idleCounter > 0) {
          idleCounter--;
          console.debug(`Runner '${ec2runner.instanceId}' will kept idle.`);
        } else {
          await removeRunner(ec2runner, ghRunner.id, repo, enableOrgLevel, githubAppClient);
        }
      }
    }

    // Remove orphan AWS runners.
    if (orphanEc2Runner) {
      console.info(`Runner '${ec2runner.instanceId}' is orphan, and will be removed.`);
      try {
        await terminateRunner(ec2runner);
      } catch (e) {
        console.debug(`Orphan runner '${ec2runner.instanceId}' cannot be removed.`);
      }
    }
  }
}

import { Metrics, RefreshChronMetrics } from './metrics';
import { Config } from './config';
import { getRunnerTypes } from './gh-runners';
import { listRunners, RunnerInputParameters, RunnerType, shouldRefreshRunner, tryReuseRunner } from './runners';
import { getRepo, getRepoKey, Repo, RunnerInfo } from './utils';
import { createRunnerConfigArgument } from './scale-up';

export async function refreshChron(): Promise<void> {
  const metrics = new RefreshChronMetrics()

  const ec2runners = await listRunners(metrics, {
    containsTags: ['GithubRunnerID', 'EphemeralRunnerFinished'],
  });
  for (const ec2runner of ec2runners) {
    try {

      // fetches the repo from the runner config
      const repo: Repo = (() => {
        if (Config.Instance.scaleConfigRepo) {
          return {
            owner: ec2runner.org !== undefined ? (ec2runner.org as string) : getRepo(ec2runner.repo as string).owner,
            repo: Config.Instance.scaleConfigRepo,
          };
        }
        return getRepo(ec2runner.repo as string);
      })();

      // fetches the github runner type from the repo config
      const runnerType = await getGHRunnerType(ec2runner, metrics, repo);
      if (runnerType === null) {
        console.warn(`Could not find runner type for ${ec2runner} in repo ${repo}`);
        continue;
      }

      // only refresh ephemeral runners
      if (!runnerType.is_ephemeral) {
        continue;
      }

      if(!shouldRefreshRunner(ec2runner, 'refresh-runner')) {
        continue;
      }

      const refreshRunnerParams: RunnerInputParameters = {
        environment: Config.Instance.environment,
        runnerConfig: (awsRegion: string, experimentalRunner: boolean) => {
          return createRunnerConfigArgument(
            runnerType,
            repo,
            undefined, // undefined means we want to use the default config
            metrics,
            awsRegion,
            experimentalRunner,
          );
        },
        runnerType: runnerType,
      };

      if (Config.Instance.enableOrganizationRunners) {
        refreshRunnerParams.orgName = repo.owner;
      } else {
        refreshRunnerParams.repoName = getRepoKey(repo);
      }

      try {
        await tryReuseRunner(refreshRunnerParams, metrics);
        continue; // Runner successfuly reused, no need to create a new one, continue to next runner
      } catch (e) {
        console.error(`Error reusing runner: ${e}`);
      }
    } catch (e) {
      console.error(`Error refresh instances: ${e}`);
    }
  }
}

export async function getGHRunnerType(ec2runner: RunnerInfo, metrics: Metrics, repo: Repo): Promise<RunnerType | null> {
  if (ec2runner.runnerType === undefined) {
    return null;
  }
  const runnerTypes = await getRunnerTypes(repo, metrics);
  return runnerTypes.get(ec2runner.runnerType) ?? null;
}

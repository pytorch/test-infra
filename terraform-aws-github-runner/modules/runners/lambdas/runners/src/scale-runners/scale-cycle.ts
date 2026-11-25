import { Config } from './config';
import { listRunners, RunnerInputParameters, tryReuseRunner } from './runners';
import { getRepo, getRepoKey } from './utils';
import { ScaleCycleMetrics } from './metrics';
import { getRunnerTypes } from './gh-runners';
import { createRunnerConfigArgument } from './scale-up';

export async function scaleCycle(metrics: ScaleCycleMetrics) {
  // Get runner types configuration first
  const scaleConfigRepo = getRepo(Config.Instance.scaleConfigOrg, Config.Instance.scaleConfigRepo);
  const runnerTypes = await getRunnerTypes(scaleConfigRepo, metrics);

  // Get all valid runner type names for filtering
  const validRunnerTypeNames = Array.from(runnerTypes.keys());

  // Make separate calls for each runner type to filter at EC2 level
  const allRunners = await Promise.all(
    validRunnerTypeNames.map((runnerTypeName) =>
      listRunners(metrics, {
        containsTags: ['GithubRunnerID', 'EphemeralRunnerFinished', 'RunnerType'],
        runnerType: runnerTypeName,
      }),
    ),
  );

  // Flatten the results
  const runners = allRunners.flat();

  for (const runner of runners) {
    // Skip if required fields are missing (org/repo still need to be checked)
    if (!runner.runnerType || !runner.org || !runner.repo) {
      console.warn(`Skipping runner ${runner.instanceId} due to missing required tags`);
      continue;
    }

    // Get the RunnerType object from the string (we know it exists since we filtered by it)
    const runnerType = runnerTypes.get(runner.runnerType);
    if (!runnerType) {
      console.warn(`Unknown runner type: ${runner.runnerType}, skipping`);
      continue;
    }

    // Create repo object
    const repo = getRepo(runner.org, runner.repo);

    // For each runner send an EBS volume replacement task
    const runnerInputParameters: RunnerInputParameters = {
      runnerConfig: (awsRegion: string, experimentalRunner: boolean) => {
        return createRunnerConfigArgument(
          runnerType,
          repo,
          // NOTE: installationId can actually be undefined here but this may incur lower rate limits
          // TODO: figure out if we need to pass an actual installationId here
          undefined,
          metrics,
          awsRegion,
          experimentalRunner,
        );
      },
      environment: Config.Instance.environment,
      runnerType: runnerType,
    };

    // Set orgName or repoName based on configuration
    if (Config.Instance.enableOrganizationRunners) {
      runnerInputParameters.orgName = runner.org;
      metrics.scaleCycleRunnerReuseFoundOrg(runner.org, runner.runnerType);
      console.info(`Reusing runner ${runner.instanceId} for ${runner.org}`);
    } else {
      runnerInputParameters.repoName = getRepoKey(repo);
      metrics.scaleCycleRunnerReuseFoundRepo(getRepoKey(repo), runner.runnerType);
      console.info(`Reusing runner ${runner.instanceId} for ${getRepoKey(repo)}`);
    }

    await tryReuseRunner(runnerInputParameters, metrics);
  }
}

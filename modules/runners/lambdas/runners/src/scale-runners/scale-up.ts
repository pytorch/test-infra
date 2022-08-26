import { Repo, getRepoKey } from './utils';
import {
  RunnerType,
  createRegistrationTokenOrg,
  createRegistrationTokenRepo,
  createRunner,
  getRunnerTypes,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
} from './runners';
import { getRepoIssuesWithLabel } from './gh-issues';
import { ScaleUpMetrics } from './metrics';

import { Config } from './config';

export interface ActionRequestMessage {
  id: number;
  eventType: string;
  repositoryName: string;
  repositoryOwner: string;
  installationId?: number;
  runnerLabels?: string[];
}

export async function scaleUp(eventSource: string, payload: ActionRequestMessage): Promise<void> {
  if (eventSource !== 'aws:sqs') throw Error('Cannot handle non-SQS events!');

  const metrics = new ScaleUpMetrics();

  const repo: Repo = {
    owner: payload.repositoryOwner,
    repo: payload.repositoryName,
  };

  if (await shouldSkipForRepo(repo)) {
    metrics.skipRepo(repo);
    return;
  }

  metrics.runRepo(repo);

  try {
    const runnerTypes = await getRunnerTypes({
      owner: repo.owner,
      repo: Config.Instance.enableOrganizationRunners ? Config.Instance.scaleConfigRepo : repo.repo,
    });
    /* istanbul ignore next */
    const runnerLabels = payload?.runnerLabels ?? Array.from(runnerTypes.keys());

    // ideally we should only have one label specfied but loop so we can go through them all if there are multiple
    // if no labels are found this should just be a no-op
    for (const runnerLabel of runnerLabels) {
      const runnerType = runnerTypes.get(runnerLabel);
      if (runnerType === undefined) {
        console.info(`Runner label '${runnerLabel}' was not found in config for ` + `${repo.owner}/${repo.repo}`);
        continue;
      }
      if (await allRunnersBusy(runnerType.runnerTypeName, repo, runnerType.is_ephemeral, runnerType.max_available)) {
        try {
          await createRunner({
            environment: Config.Instance.environment,
            runnerConfig: await createRunnerConfigArgument(runnerType, repo, payload.installationId),
            orgName: Config.Instance.enableOrganizationRunners ? repo.owner : undefined,
            repoName: Config.Instance.enableOrganizationRunners ? undefined : getRepoKey(repo),
            runnerType: runnerType,
          });
        } catch (e) {
          console.error(`Error spinning up instance of type ${runnerType.runnerTypeName}: ${e}`);
        }
      } else {
        console.info('There are available runners, no new runners will be created');
      }
    }
  } finally {
    metrics.sendMetrics();
  }
}

async function createRunnerConfigArgument(
  runnerType: RunnerType,
  repo: Repo,
  installationId: number | undefined,
): Promise<string> {
  const ephemeralArgument = runnerType.is_ephemeral ? '--ephemeral' : '';
  const labelsArgument =
    Config.Instance.runnersExtraLabels !== undefined
      ? `${runnerType.runnerTypeName},${Config.Instance.runnersExtraLabels}`
      : `${runnerType.runnerTypeName}`;

  if (Config.Instance.enableOrganizationRunners) {
    /* istanbul ignore next */
    const runnerGroupArgument =
      Config.Instance.runnerGroupName !== undefined ? `--runnergroup ${Config.Instance.runnerGroupName}` : '';
    const token = await createRegistrationTokenOrg(repo.owner, installationId);
    return (
      `--url ${Config.Instance.ghesUrlHost}/${repo.owner} ` +
      `--token ${token} --labels ${labelsArgument} ${ephemeralArgument} ${runnerGroupArgument}`
    );
  } else {
    const token = await createRegistrationTokenRepo(repo, installationId);
    return (
      `--url ${Config.Instance.ghesUrlHost}/${repo.owner}/${repo.repo} ` +
      `--token ${token} --labels ${labelsArgument} ${ephemeralArgument}`
    );
  }
}

async function shouldSkipForRepo(repo: Repo): Promise<boolean> {
  if (Config.Instance.mustHaveIssuesLabels) {
    for (let i = 0; i < Config.Instance.mustHaveIssuesLabels.length; i++) {
      const label = Config.Instance.mustHaveIssuesLabels[i];
      if ((await getRepoIssuesWithLabel(repo, label)).length == 0) {
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
    if ((await getRepoIssuesWithLabel(repo, label)).length > 0) {
      console.warn(
        `Skipping scaleUp for repo '${repo.owner}/${repo.repo}' as a open issue ` +
          `with label '${label}' must not be present`,
      );
      return true;
    }
  }

  return false;
}

async function allRunnersBusy(
  runnerType: string,
  repo: Repo,
  isEphemeral: boolean,
  maxAvailable: number,
): Promise<boolean> {
  const ghRunners = Config.Instance.enableOrganizationRunners
    ? await listGithubRunnersOrg(repo.owner)
    : await listGithubRunnersRepo(repo);

  const runnersWithLabel = ghRunners.filter(
    (x) => x.labels.some((y) => y.name === runnerType) && x.status.toLowerCase() !== 'offline',
  );
  const busyCount = runnersWithLabel.filter((x) => x.busy).length;
  console.info(
    `Found matching GitHub runners [${runnerType}], ${busyCount}/` +
      `${runnersWithLabel.length}/${ghRunners.length} are busy`,
  );

  // If a runner isn't ephemeral then maxAvailable should be applied
  if (!isEphemeral && runnersWithLabel.length >= maxAvailable) {
    console.info(`Max runners hit [${runnerType}], ${busyCount}/${runnersWithLabel.length}/${ghRunners.length}`);
    return false;
  }

  // Have a fail safe just in case we're likely to need more runners
  const availableCount = runnersWithLabel.length - busyCount;
  if (availableCount < Config.Instance.minAvailableRunners) {
    console.info(`Available (${availableCount}) runners is bellow minimum ${Config.Instance.minAvailableRunners}`);
    return true;
  }

  return false;
}

import {
  Repo,
  createRegistrationTokenForRepo,
  createRunner,
  getRepoKey,
  getRunnerTypes,
  listGithubRunners,
} from './runners';

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

  const repo: Repo = {
    owner: payload.repositoryOwner,
    repo: payload.repositoryName,
  };

  const runnerTypes = await getRunnerTypes(repo);
  /* istanbul ignore next */
  const runnerLabels = payload?.runnerLabels ?? Array.from(runnerTypes.keys());

  // ideally we should only have one label specfied but loop so we can go through them all if there are multiple
  // if no labels are found this should just be a no-op
  for (const runnerLabel of runnerLabels) {
    const runnerType = runnerTypes.get(runnerLabel);
    if (runnerType === undefined) {
      console.info(
        `Runner label '${runnerLabel}' was not found in config for ` +
          `${payload.repositoryOwner}/${payload.repositoryName}`,
      );
      continue;
    }
    if (await allRunnersBusy(runnerType.runnerTypeName, repo, runnerType.is_ephemeral, runnerType.max_available)) {
      try {
        const labelsArgument =
          Config.Instance.runnersExtraLabels !== undefined
            ? `--labels ${runnerType.runnerTypeName},${Config.Instance.runnersExtraLabels}`
            : `--labels ${runnerType.runnerTypeName}`;
        const ephemeralArgument = runnerType.is_ephemeral ? '--ephemeral' : '';
        const token = await createRegistrationTokenForRepo(repo, payload.installationId);
        await createRunner({
          environment: Config.Instance.environment,
          runnerConfig:
            `--url ${Config.Instance.ghesUrlHost}/${repo.owner}/${repo.repo} ` +
            `--token ${token} ${labelsArgument} ${ephemeralArgument}`,
          repoName: getRepoKey(repo),
          runnerType: runnerType,
        });
      } catch (e) {
        console.error(`Error spinning up instance of type ${runnerType.runnerTypeName}: ${e}`);
      }
    } else {
      console.info('There are available runners, no new runners will be created');
    }
  }
}

async function allRunnersBusy(
  runnerType: string,
  repo: Repo,
  isEphemeral: boolean,
  maxAvailable: number,
): Promise<boolean> {
  const ghRunners = await listGithubRunners(repo);

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

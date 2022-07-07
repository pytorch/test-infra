import { listRunners, createRunner, RunnerType, createGitHubClientForRunner, listGithubRunners } from './runners';
import { createOctoClient, createGithubAuth } from './gh-auth';
import LRU from 'lru-cache';
import YAML from 'yaml';

export interface ActionRequestMessage {
  id: number;
  eventType: string;
  repositoryName: string;
  repositoryOwner: string;
  installationId: number;
  runnerLabels: string[];
}

export const scaleUp = async (eventSource: string, payload: ActionRequestMessage): Promise<void> => {
  if (eventSource !== 'aws:sqs') throw Error('Cannot handle non-SQS events!');
  const enableOrgLevel = false;
  const runnerExtraLabels = process.env.RUNNER_EXTRA_LABELS;
  const runnerGroup = process.env.RUNNER_GROUP_NAME;
  const environment = process.env.ENVIRONMENT as string;

  let ghesApiUrl = '';

  let installationId = payload.installationId;
  if (installationId == 0) {
    const ghAuth = await createGithubAuth(undefined, 'app', ghesApiUrl);
    const githubClient = await createOctoClient(ghAuth.token, ghesApiUrl);
    installationId = enableOrgLevel
      ? (
          await githubClient.apps.getOrgInstallation({
            org: payload.repositoryOwner,
          })
        ).data.id
      : (
          await githubClient.apps.getRepoInstallation({
            owner: payload.repositoryOwner,
            repo: payload.repositoryName,
          })
        ).data.id;
  }

  const ghAuth = await createGithubAuth(installationId, 'installation', ghesApiUrl);
  const githubInstallationClient = await createOctoClient(ghAuth.token, ghesApiUrl);

  const repoName = enableOrgLevel ? undefined : `${payload.repositoryOwner}/${payload.repositoryName}`;
  const orgName = enableOrgLevel ? payload.repositoryOwner : undefined;

  const currentRunners = await listRunners({
    environment: environment,
    repoName: repoName,
  });
  console.info(
    `${
      enableOrgLevel
        ? `Organization ${payload.repositoryOwner}`
        : `Repo ${payload.repositoryOwner}/${payload.repositoryName}`
    } has ${currentRunners.length} runners`,
  );

  const runnerTypes = await GetRunnerTypes(
    payload.repositoryOwner,
    `${payload.repositoryOwner}/${payload.repositoryName}`,
    enableOrgLevel,
  );

  const runnerLabels = payload.runnerLabels !== undefined ? payload.runnerLabels : Array.from(runnerTypes.keys());

  // ideally we should only have one label specfied but loop so we can go through them all if there are multiple
  // if no labels are found this should just be a no-op
  for (const runnerLabel of runnerLabels) {
    const runnerType = runnerTypes.get(runnerLabel);
    if (runnerType === undefined) {
      console.info(
        `Runner label '${runnerLabel}' was not found in config for ${payload.repositoryOwner}/${payload.repositoryName}`,
      );
      continue;
    }
    // check if all runners are busy
    if (
      await allRunnersBusy(
        runnerType.runnerTypeName,
        payload.repositoryOwner,
        `${payload.repositoryOwner}/${payload.repositoryName}`,
        enableOrgLevel,
        runnerType.is_ephemeral,
        runnerType.max_available,
      )
    ) {
      // create token
      const registrationToken = enableOrgLevel
        ? await githubInstallationClient.actions.createRegistrationTokenForOrg({ org: payload.repositoryOwner })
        : await githubInstallationClient.actions.createRegistrationTokenForRepo({
            owner: payload.repositoryOwner,
            repo: payload.repositoryName,
          });
      const token = registrationToken.data.token;

      const labelsArgument =
        runnerExtraLabels !== undefined
          ? `--labels ${runnerType.runnerTypeName},${runnerExtraLabels}`
          : `--labels ${runnerType.runnerTypeName}`;
      const ephemeralArgument = runnerType.is_ephemeral ? '--ephemeral' : '';
      const runnerGroupArgument = runnerGroup !== undefined ? ` --runnergroup ${runnerGroup}` : '';
      const configBaseUrl = 'https://github.com';
      try {
        await createRunner({
          environment: environment,
          runnerConfig: enableOrgLevel
            ? `--url ${configBaseUrl}/${payload.repositoryOwner} --token ${token} ${labelsArgument}${runnerGroupArgument} ${ephemeralArgument}`
            : `--url ${configBaseUrl}/${payload.repositoryOwner}/${payload.repositoryName} ` +
              `--token ${token} ${labelsArgument} ${ephemeralArgument}`,
          orgName: orgName,
          repoName: repoName,
          runnerType: runnerType,
        });
      } catch (e) {
        console.error(`Error spinning up instance of type ${runnerType.runnerTypeName}: ${e}`);
      }
    } else {
      console.info('There are available runners, no new runners will be created');
    }
  }
};

// Buffer to determine how many available
const NUM_ALLOWED_TO_BE_AVAILABLE = 10;

async function allRunnersBusy(
  runnerType: string,
  org: string,
  repo: string,
  enableOrgLevel: boolean,
  isEphemeral: boolean,
  maxAvailable: number,
): Promise<boolean> {
  const githubAppClient = await createGitHubClientForRunner(org, repo, enableOrgLevel);
  const ghRunners = await listGithubRunners(githubAppClient, org, repo, enableOrgLevel);

  const runnersWithLabel = ghRunners.filter(
    (x) => x.labels.some((y) => y.name === runnerType) && x.status.toLowerCase() !== 'offline',
  );
  const busyCount = runnersWithLabel.filter((x) => x.busy).length;
  const availableCount = runnersWithLabel.length - busyCount;

  console.info(`Found matching GitHub runners [${runnerType}], ${busyCount}/${runnersWithLabel.length} are busy`);
  // If a runner isn't ephemeral then maxAvailable should be applied
  if (!isEphemeral && runnersWithLabel.length >= maxAvailable) {
    console.info(`Max runners hit [${runnerType}], ${busyCount}/${runnersWithLabel.length}`);
    return false;
  }
  // Have a fail safe just in case we're likely to need more runners
  if (availableCount < NUM_ALLOWED_TO_BE_AVAILABLE) {
    console.info(`Available (${availableCount}) runners is bellow minimum hardcoded ${NUM_ALLOWED_TO_BE_AVAILABLE}`)
    return true;
  }

  return runnersWithLabel.every((x) => x.busy);
}

const runnerTypeCache = new LRU();

async function GetRunnerTypes(org: string, repo: string, enableOrgLevel: boolean): Promise<Map<string, RunnerType>> {
  const runnerTypeKey = `${org}/${repo}/enableOrgLevel=${enableOrgLevel}`;

  if (runnerTypeCache.get(runnerTypeKey) !== undefined) {
    console.debug(`[GetRunnerTypes] Cached runnerTypes found`);
    return runnerTypeCache.get(runnerTypeKey) as Map<string, RunnerType>;
  }
  console.debug(`[GetRunnerTypes] Grabbing runnerTypes`);

  const githubAppClient = await createGitHubClientForRunner(org, repo, enableOrgLevel);
  // For org enabled runners we use ${org}/.github as the repository to hold the singular configuration
  const configRepository = enableOrgLevel ? '.github' : repo.split('/')[1];
  const response = await githubAppClient.repos.getContent({
    owner: org,
    repo: configRepository,
    path: '.github/scale-config.yml',
  });
  const { content } = { ...response.data };

  if (response.status != 200 || !content) {
    throw Error(`Issue (${response.status}) retrieving '.github/scale-config.yml' for https://github.com/${org}/${configRepository}/`);
  }

  const buff = Buffer.from(content, 'base64');
  const configYml = buff.toString('ascii');

  console.debug(`scale-config.yml contents: ${configYml}`);

  let config = YAML.parse(configYml);
  let result: Map<string, RunnerType> = new Map<string, RunnerType>();

  for (const prop in config.runner_types) {
    let isEphemeral = true;
    if (config.runner_types[prop].is_ephemeral !== undefined) {
      isEphemeral = config.runner_types[prop].is_ephemeral;
    }
    let runnerType: RunnerType = {
      runnerTypeName: prop,
      instance_type: config.runner_types[prop].instance_type,
      os: config.runner_types[prop].os,
      max_available: config.runner_types[prop].max_available,
      disk_size: config.runner_types[prop].disk_size,
      is_ephemeral: isEphemeral,
    };
    result.set(prop, runnerType);
  }

  runnerTypeCache.set(runnerTypeKey, result);
  console.debug(`configuration: ${JSON.stringify(result)}`);

  return result;
}

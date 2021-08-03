import { listRunners, createRunner, RunnerType, createGitHubClientForRunnerFactory, listGithubRunnersFactory } from './runners';
import { createOctoClient, createGithubAuth } from './gh-auth';
import yn from 'yn';
import YAML from 'yaml'

export interface ActionRequestMessage {
  id: number;
  eventType: string;
  repositoryName: string;
  repositoryOwner: string;
  installationId: number;
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
  const checkRun = await githubInstallationClient.checks.get({
    check_run_id: payload.id,
    owner: payload.repositoryOwner,
    repo: payload.repositoryName,
  });

  const repoName = enableOrgLevel ? undefined : `${payload.repositoryOwner}/${payload.repositoryName}`;
  const orgName = enableOrgLevel ? payload.repositoryOwner : undefined;

  if (checkRun.data.status === 'queued') {
    const currentRunners = await listRunners({
      environment: environment,
      repoName: repoName,
    });
    console.info(
      `${enableOrgLevel
        ? `Organization ${payload.repositoryOwner}`
        : `Repo ${payload.repositoryOwner}/${payload.repositoryName}`
      } has ${currentRunners.length} runners`,
    );

    const runnerTypes = await GetRunnerTypes(payload.repositoryOwner, `${payload.repositoryOwner}/${payload.repositoryName}`, enableOrgLevel);

    for (const runnerType of runnerTypes) {
      try {
        const currentRunnerCount = currentRunners.filter(x => x.runnerType === runnerType.runnerTypeName).length;
        if (currentRunnerCount < runnerType.max_available) {
          // check if all runners are busy
          if (await allRunnersBusy(runnerType.runnerTypeName, payload.repositoryOwner, `${payload.repositoryOwner}/${payload.repositoryName}`, enableOrgLevel)) {
            // create token
            const registrationToken = enableOrgLevel
              ? await githubInstallationClient.actions.createRegistrationTokenForOrg({ org: payload.repositoryOwner })
              : await githubInstallationClient.actions.createRegistrationTokenForRepo({
                owner: payload.repositoryOwner,
                repo: payload.repositoryName,
              });
            const token = registrationToken.data.token;

            const labelsArgument = runnerExtraLabels !== undefined ? `--labels ${runnerType.runnerTypeName},${runnerExtraLabels}` : `--labels ${runnerType.runnerTypeName}`;
            const runnerGroupArgument = runnerGroup !== undefined ? ` --runnergroup ${runnerGroup}` : '';
            const configBaseUrl = 'https://github.com';
            await createRunner({
              environment: environment,
              runnerConfig: enableOrgLevel
                ? `--url ${configBaseUrl}/${payload.repositoryOwner} --token ${token} ${labelsArgument}${runnerGroupArgument}`
                : `--url ${configBaseUrl}/${payload.repositoryOwner}/${payload.repositoryName} ` +
                `--token ${token} ${labelsArgument}`,
              orgName: orgName,
              repoName: repoName,
              runnerType: runnerType,
            });
          } else {
            console.info('There are available runners, no new runners will be created');
          }
        } else {
          console.info('No runner will be created, maximum number of runners reached.');
        }
      } catch(e) {
        console.error(`Error spinning up instance of type ${runnerType.runnerTypeName}: ${e}`)
      }
    }
  }
};

async function allRunnersBusy(runnerType: string, org: string, repo: string, enableOrgLevel: boolean): Promise<boolean> {
  const createGitHubClientForRunner = createGitHubClientForRunnerFactory();
  const listGithubRunners = listGithubRunnersFactory();

  const githubAppClient = await createGitHubClientForRunner(org, repo, enableOrgLevel);
  const ghRunners = await listGithubRunners(githubAppClient, org, repo, enableOrgLevel);

  const runnersWithLabel = ghRunners.filter(x => x.labels.some(y => y.name === runnerType) && x.status.toLowerCase() !== "offline");
  const busyCount = ghRunners.filter(x => x.busy).length;

  console.info(`Found ${runnersWithLabel.length} matching GitHub runners [${runnerType}], ${busyCount} are busy`);

  return runnersWithLabel.every(x => x.busy);
}

async function GetRunnerTypes(org: string, repo: string, enableOrgLevel: boolean): Promise<RunnerType[]> {
  const createGitHubClientForRunner = createGitHubClientForRunnerFactory();

  const githubAppClient = await createGitHubClientForRunner(org, repo, enableOrgLevel);

  const response = (await githubAppClient.repos.getContent({
    owner: org,
    repo: repo.split('/')[1],
    path: '.github/scale-config.yml',
  }));

  const { content } = { ...response.data };

  if (!content) {
    throw Error('Could not retrieve .github/scale-config.yml');
  }

  const buff = Buffer.from(content, 'base64');
  const configYml = buff.toString('ascii');

  console.debug(`scale-config.yml contents: ${configYml}`);

  let config = YAML.parse(configYml);
  let result: RunnerType[] = [];

  for (const prop in config.runner_types) {
    let runnerType: RunnerType = {
      runnerTypeName: prop,
      instance_type: config.runner_types[prop].instance_type,
      os: config.runner_types[prop].os,
      max_available: config.runner_types[prop].max_available,
      disk_size: config.runner_types[prop].disk_size,
    };

    result.push(runnerType);
  }

  console.debug(`configuration: ${JSON.stringify(result)}`);

  return result;
}


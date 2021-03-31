import { listRunners, createRunner, RunnerType, createGitHubClientForRunnerFactory, listGithubRunnersFactory } from './runners';
import { createOctoClient, createGithubAuth } from './gh-auth';
import yn from 'yn';

export interface ActionRequestMessage {
  id: number;
  eventType: string;
  repositoryName: string;
  repositoryOwner: string;
  installationId: number;
}

export interface Dictionary<T> {
  [Key: string]: T;
}

export const scaleUp = async (eventSource: string, payload: ActionRequestMessage): Promise<void> => {
  if (eventSource !== 'aws:sqs') throw Error('Cannot handle non-SQS events!');
  const enableOrgLevel = yn(process.env.ENABLE_ORGANIZATION_RUNNERS, { default: true });
  const maximumRunners = parseInt(process.env.RUNNERS_MAXIMUM_COUNT || '3');
  const runnerExtraLabels = process.env.RUNNER_EXTRA_LABELS;
  const runnerGroup = process.env.RUNNER_GROUP_NAME;
  const environment = process.env.ENVIRONMENT as string;
  const ghesBaseUrl = process.env.GHES_URL as string;

  let ghesApiUrl = '';
  if (ghesBaseUrl) {
    ghesApiUrl = `${ghesBaseUrl}/api/v3`;
  }

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
      } has ${currentRunners.length}/${maximumRunners} runners`,
    );

    // const runnerTypes = GetRunnerTypes();
    const runnerTypes: Dictionary<RunnerType> = {
      linuxCpu: {
        instance_type: 'c5.2xlarge',
        os: 'linux',
        max_available: 200,
        disk_size: 100,
        runnerTypeName: 'linuxCpu',
      },
      linuxGpu: {
        instance_type: 'c5.2xlarge',
        os: 'linux',
        max_available: 200,
        disk_size: 100,
        runnerTypeName: 'linuxGpu',
      },
      windowsCpu: {
        instance_type: 'c5.2xlarge',
        os: 'windows',
        max_available: 200,
        disk_size: 100,
        runnerTypeName: 'windowsCpu',
      },
      windowsGpu: {
        instance_type: 'c5.2xlarge',
        os: 'windows',
        max_available: 200,
        disk_size: 100,
        runnerTypeName: 'windowsGpu',
      },
    }

    for (const runnerType in runnerTypes) {
      const currentRunnerCount = currentRunners.filter(x => x.runnerType === runnerType).length;

      if (currentRunnerCount < runnerTypes[runnerType].max_available) {
        // check if all runners are busy
        if (allRunnersBusy(runnerType, payload.repositoryOwner, `${payload.repositoryOwner}/${payload.repositoryName}`, enableOrgLevel)) {
          // create token
          const registrationToken = enableOrgLevel
            ? await githubInstallationClient.actions.createRegistrationTokenForOrg({ org: payload.repositoryOwner })
            : await githubInstallationClient.actions.createRegistrationTokenForRepo({
              owner: payload.repositoryOwner,
              repo: payload.repositoryName,
            });
          const token = registrationToken.data.token;

          const labelsArgument = runnerExtraLabels !== undefined ? `--labels ${runnerType},${runnerExtraLabels}` : `--labels ${runnerType}`;
          const runnerGroupArgument = runnerGroup !== undefined ? ` --runnergroup ${runnerGroup}` : '';
          const configBaseUrl = ghesBaseUrl ? ghesBaseUrl : 'https://github.com';
          await createRunner({
            environment: environment,
            runnerConfig: enableOrgLevel
              ? `--url ${configBaseUrl}/${payload.repositoryOwner} --token ${token} ${labelsArgument}${runnerGroupArgument}`
              : `--url ${configBaseUrl}/${payload.repositoryOwner}/${payload.repositoryName} ` +
              `--token ${token} ${labelsArgument}`,
            orgName: orgName,
            repoName: repoName,
            runnerType: runnerTypes[runnerType],
          });
        } else {
          console.info('No runner will be created, maximum number of runners reached.');
        }
      }
    }
  }
};

async function allRunnersBusy(runnerType: string, org: string, repo: string, enableOrgLevel: boolean): Promise<boolean> {
  const createGitHubClientForRunner = createGitHubClientForRunnerFactory();
  const listGithubRunners = listGithubRunnersFactory();

  const githubAppClient = await createGitHubClientForRunner(org, repo, enableOrgLevel);
  const ghRunners = await listGithubRunners(githubAppClient, org, repo, enableOrgLevel);

  const runnersWithLabel = ghRunners.filter(x => x.labels.some(y => y.name === runnerType) && x.status !== "offline");
  const busyCount = ghRunners.filter(x => x.busy).length;

  console.info(`Found ${runnersWithLabel.length} matching GitHub runners, ${busyCount} are busy`);

  return runnersWithLabel.every(x => x.busy);
}

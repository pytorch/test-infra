import { EC2, SSM } from 'aws-sdk';
import { Octokit } from '@octokit/rest';
import { createOctoClient, createGithubAuth } from './gh-auth';
import LRU from 'lru-cache';

export interface RunnerInfo {
  instanceId: string;
  launchTime: Date | undefined;
  repo: string | undefined;
  org: string | undefined;
  runnerType: string | undefined;
}

export interface ListRunnerFilters {
  repoName?: string;
  orgName?: string;
  environment?: string;
}

export interface RunnerType {
  instance_type: string;
  os: string;
  max_available: number;
  disk_size: number;
  runnerTypeName: string;
}

export async function listRunners(filters: ListRunnerFilters | undefined = undefined): Promise<RunnerInfo[]> {
  const ec2 = new EC2();
  const ec2Filters = [
    { Name: 'tag:Application', Values: ['github-action-runner'] },
    { Name: 'instance-state-name', Values: ['running', 'pending'] },
  ];
  if (filters) {
    if (filters.environment !== undefined) {
      ec2Filters.push({ Name: 'tag:Environment', Values: [filters.environment] });
    }
    if (filters.repoName !== undefined) {
      ec2Filters.push({ Name: 'tag:Repo', Values: [filters.repoName] });
    }
    if (filters.orgName !== undefined) {
      ec2Filters.push({ Name: 'tag:Org', Values: [filters.orgName] });
    }
  }
  const runningInstances = await ec2.describeInstances({ Filters: ec2Filters }).promise();
  const runners: RunnerInfo[] = [];
  if (runningInstances.Reservations) {
    for (const r of runningInstances.Reservations) {
      if (r.Instances) {
        for (const i of r.Instances) {
          runners.push({
            instanceId: i.InstanceId as string,
            launchTime: i.LaunchTime,
            repo: i.Tags?.find((e) => e.Key === 'Repo')?.Value,
            org: i.Tags?.find((e) => e.Key === 'Org')?.Value,
            runnerType: i.Tags?.find((e) => e.Key === 'RunnerType')?.Value,
          });
        }
      }
    }
  }
  return runners;
}

export interface RunnerInputParameters {
  runnerConfig: string;
  environment: string;
  repoName?: string;
  orgName?: string;
  runnerType: RunnerType;
}

export async function terminateRunner(runner: RunnerInfo): Promise<void> {
  const ec2 = new EC2();
  await ec2
    .terminateInstances({
      InstanceIds: [runner.instanceId],
    })
    .promise();
  console.debug('Runner terminated.' + runner.instanceId);
}

export async function createRunner(runnerParameters: RunnerInputParameters): Promise<void> {
  const launchTemplateNameLinux = process.env.LAUNCH_TEMPLATE_NAME_LINUX as string;
  const launchTemplateVersionLinux = process.env.LAUNCH_TEMPLATE_VERSION_LINUX as string;
  const launchTemplateNameWindows = process.env.LAUNCH_TEMPLATE_NAME_WINDOWS as string;
  const launchTemplateVersionWindows = process.env.LAUNCH_TEMPLATE_VERSION_WINDOWS as string;
  const securityGroupIDs = process.env.SECURITY_GROUP_IDS as string;

  const subnets = (process.env.SUBNET_IDS as string).split(',');
  console.debug('Runner configuration: ' + JSON.stringify(runnerParameters));
  const ec2 = new EC2();
  const storageDeviceName = runnerParameters.runnerType.os === 'linux' ? '/dev/xvda' : '/dev/sda1';
  const maxRetries = subnets.length;
  for (let x = 1; x <= maxRetries; x++) {
    try {
      console.debug(`[${x}/${maxRetries}] Attempting to create instance ${runnerParameters.runnerType.instance_type}`);
      // Trying different subnets since some subnets don't always work for specific instance types
      // Tries to resolve for errors like:
      //   Your requested instance type (c5.2xlarge) is not supported in your requested Availability Zone (us-east-1e).
      //   Please retry your request by not specifying an Availability Zone or choosing us-east-1a, us-east-1b, us-east-1c, us-east-1d, us-east-1f.
      const randomSubnet = subnets.splice(Math.floor(Math.random() * subnets.length), 1)[0];
      const runInstancesResponse = await ec2
        .runInstances({
          MaxCount: 1,
          MinCount: 1,
          LaunchTemplate: {
            LaunchTemplateName:
              runnerParameters.runnerType.os === 'linux' ? launchTemplateNameLinux : launchTemplateNameWindows,
            Version:
              runnerParameters.runnerType.os === 'linux' ? launchTemplateVersionLinux : launchTemplateVersionWindows,
          },
          InstanceType: runnerParameters.runnerType.instance_type,
          BlockDeviceMappings: [
            {
              DeviceName: storageDeviceName,
              Ebs: {
                VolumeSize: runnerParameters.runnerType.disk_size,
                VolumeType: 'gp3',
                Encrypted: true,
                DeleteOnTermination: true,
              },
            },
          ],
          NetworkInterfaces: [
            {
              AssociatePublicIpAddress: true,
              SubnetId: randomSubnet,
              Groups: securityGroupIDs.split(','),
              DeviceIndex: 0,
            },
          ],
          TagSpecifications: [
            {
              ResourceType: 'instance',
              Tags: [
                { Key: 'Application', Value: 'github-action-runner' },
                {
                  Key: runnerParameters.orgName ? 'Org' : 'Repo',
                  Value: runnerParameters.orgName ? runnerParameters.orgName : runnerParameters.repoName,
                },
                { Key: 'RunnerType', Value: runnerParameters.runnerType.runnerTypeName },
              ],
            },
          ],
        })
        .promise();
      console.info(
        `Created instance(s) [${runnerParameters.runnerType.runnerTypeName}]: `,
        runInstancesResponse.Instances?.map((i) => i.InstanceId).join(','),
      );

      const ssm = new SSM();
      runInstancesResponse.Instances?.forEach(async (i: EC2.Instance) => {
        await ssm
          .putParameter({
            Name: runnerParameters.environment + '-' + (i.InstanceId as string),
            Value: runnerParameters.runnerConfig,
            Type: 'SecureString',
          })
          .promise();
      });
      break;
    } catch (e) {
      if (x === maxRetries) {
        console.error(
          `[${x}/${maxRetries}] Max retries exceeded creating instance ${runnerParameters.runnerType.instance_type}: ${e}`,
        );
        throw e;
      } else {
        // Pause for half a second before trying again
        await new Promise((resolve) => setTimeout(resolve, 500));
        console.warn(
          `[${x}/${maxRetries}] Issue creating instance ${runnerParameters.runnerType.instance_type}, going to retry :${e}`,
        );
      }
    }
  }
}

export interface Repo {
  repoName: string;
  repoOwner: string;
}

export function getRepo(org: string | undefined, repo: string | undefined, orgLevel: boolean): Repo {
  return orgLevel
    ? { repoOwner: org as string, repoName: '' }
    : { repoOwner: repo?.split('/')[0] as string, repoName: repo?.split('/')[1] as string };
}

const ghClientCache = new LRU({ maxAge: 60 * 1000 });

export function createGitHubClientForRunnerFactory(): (
  org: string | undefined,
  repo: string | undefined,
  orgLevel: boolean,
) => Promise<Octokit> {
  return async (org: string | undefined, repo: string | undefined, orgLevel: boolean) => {
    const ghesBaseUrl = process.env.GHES_URL as string;
    let ghesApiUrl = '';
    if (ghesBaseUrl) {
      ghesApiUrl = `${ghesBaseUrl}/api/v3`;
    }
    const ghAuth = await createGithubAuth(undefined, 'app', ghesApiUrl);
    const githubClient = await createOctoClient(ghAuth.token, ghesApiUrl);
    const repository = getRepo(org, repo, orgLevel);
    const key = orgLevel ? repository.repoOwner : `${repository.repoOwner}/${repository.repoName}`;
    const cachedOctokit = ghClientCache.get(key) as Octokit;

    if (cachedOctokit) {
      console.debug(`[createGitHubClientForRunner] Cache hit for ${key}`);
      return cachedOctokit;
    }

    console.debug(`[createGitHubClientForRunner] Cache miss for ${key}`);
    const installationId = orgLevel
      ? (
          await githubClient.apps.getOrgInstallation({
            org: repository.repoOwner,
          })
        ).data.id
      : (
          await githubClient.apps.getRepoInstallation({
            owner: repository.repoOwner,
            repo: repository.repoName,
          })
        ).data.id;
    const ghAuth2 = await createGithubAuth(installationId, 'installation', ghesApiUrl);
    const octokit = await createOctoClient(ghAuth2.token, ghesApiUrl);
    ghClientCache.set(key, octokit);

    return octokit;
  };
}

/**
 * Extract the inner type of a promise if any
 */
export type UnboxPromise<T> = T extends Promise<infer U> ? U : T;

export type GhRunners = UnboxPromise<ReturnType<Octokit['actions']['listSelfHostedRunnersForRepo']>>['data']['runners'];

// Set cache to expire every 10 seconds, we just want to avoid grabbing this for every scale request
const ghRunnersCache = new LRU({ maxAge: 10 * 1000 });

export function listGithubRunnersFactory(): (
  client: Octokit,
  org: string | undefined,
  repo: string | undefined,
  enableOrgLevel: boolean,
) => Promise<GhRunners> {
  return async (client: Octokit, org: string | undefined, repo: string | undefined, enableOrgLevel: boolean) => {
    const key: string = `${org}/${repo}`;
    // Exit out early if we have our key
    if (ghRunnersCache.get(key) !== undefined) {
      console.debug(`[listGithubRunners] Cache hit for ${key}`);
      return ghRunnersCache.get(key) as GhRunners;
    }
    const repository = getRepo(org, repo, enableOrgLevel);

    console.debug(`[listGithubRunners] Cache miss for ${key}`);
    const runners = enableOrgLevel
      ? await client.paginate(client.actions.listSelfHostedRunnersForOrg, {
          org: repository.repoOwner,
          per_page: 100,
        })
      : await client.paginate(client.actions.listSelfHostedRunnersForRepo, {
          owner: repository.repoOwner,
          repo: repository.repoName,
          per_page: 100,
        });
    ghRunnersCache.set(key, runners);
    return runners;
  };
}

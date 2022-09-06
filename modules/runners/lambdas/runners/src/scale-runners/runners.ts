import { EC2, SSM } from 'aws-sdk';
import { createGithubAuth, createOctoClient } from './gh-auth';
import { Metrics } from './metrics';

import { getRepoKey, Repo, RunnerInfo, expBackOff } from './utils';
import { Config } from './config';
import LRU from 'lru-cache';
import { Octokit } from '@octokit/rest';
import YAML from 'yaml';

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
  is_ephemeral: boolean;
}

export interface RunnerInputParameters {
  runnerConfig: string;
  environment: string;
  repoName?: string;
  orgName?: string;
  runnerType: RunnerType;
}

export async function listRunners(
  metrics: Metrics,
  filters: ListRunnerFilters | undefined = undefined,
): Promise<RunnerInfo[]> {
  try {
    const ec2Filters = [
      { Name: 'tag:Application', Values: ['github-action-runner'] },
      { Name: 'instance-state-name', Values: ['running', 'pending'] },
    ];
    if (filters) {
      const tags = {
        environment: 'tag:Environment',
        repoName: 'tag:Repo',
        orgName: 'tag:Org',
      };
      (Object.keys(tags) as Array<keyof typeof filters>)
        .filter((attr) => filters[attr] !== undefined)
        .forEach((attr) =>
          ec2Filters.push({ Name: tags[attr as keyof typeof tags], Values: [filters[attr] as string] }),
        );
    }
    const runningInstances = await metrics.trackRequest(
      metrics.ec2DescribeInstancesAWSCallSuccess,
      metrics.ec2DescribeInstancesAWSCallFailure,
      () => {
        return new EC2().describeInstances({ Filters: ec2Filters }).promise();
      },
    );
    /* istanbul ignore next */
    return (
      runningInstances?.Reservations?.flatMap((reservation) => {
        /* istanbul ignore next */
        return (
          reservation.Instances?.map((instance) => ({
            instanceId: instance.InstanceId as string,
            launchTime: instance.LaunchTime,
            repo: instance.Tags?.find((e) => e.Key === 'Repo')?.Value,
            org: instance.Tags?.find((e) => e.Key === 'Org')?.Value,
            runnerType: instance.Tags?.find((e) => e.Key === 'RunnerType')?.Value,
            ghRunnerId: instance.Tags?.find((e) => e.Key === 'GithubRunnerID')?.Value,
            environment: instance.Tags?.find((e) => e.Key === 'Environment')?.Value,
          })) ?? []
        );
      }) ?? []
    );
  } catch (e) {
    console.error(`[listRunners]: ${e}`);
    throw e;
  }
}

function getParameterNameForRunner(environment: string, instanceId: string): string {
  return `${environment}-${instanceId}`;
}

export async function terminateRunner(runner: RunnerInfo, metrics: Metrics): Promise<void> {
  try {
    const ec2 = new EC2();
    const ssm = new SSM();

    await expBackOff(() => {
      return metrics.trackRequest(
        metrics.ec2TerminateInstancesAWSCallSuccess,
        metrics.ec2TerminateInstancesAWSCallFailure,
        () => {
          return ec2.terminateInstances({ InstanceIds: [runner.instanceId] }).promise();
        },
      );
    });
    console.info(`Runner terminated: ${runner.instanceId}`);

    const paramName = getParameterNameForRunner(runner.environment || Config.Instance.environment, runner.instanceId);
    try {
      await expBackOff(() => {
        return metrics.trackRequest(
          metrics.ssmdeleteParameterAWSCallSuccess,
          metrics.ssmdeleteParameterAWSCallFailure,
          () => {
            return ssm.deleteParameter({ Name: paramName }).promise();
          },
        );
      });
      console.info(`Parameter deleted: ${paramName}`);
    } catch (e) {
      console.error(`[terminateRunner - SSM.deleteParameter] Failed deleting parameter ${paramName}: ${e}`);
    }
  } catch (e) {
    console.error(`[terminateRunner]: ${e}`);
    throw e;
  }
}

export async function createRunner(runnerParameters: RunnerInputParameters, metrics: Metrics): Promise<void> {
  try {
    console.debug('Runner configuration: ' + JSON.stringify(runnerParameters));

    const ec2 = new EC2();
    const ssm = new SSM();
    const storageDeviceName = runnerParameters.runnerType.os === 'linux' ? '/dev/xvda' : '/dev/sda1';
    const subnets = Config.Instance.shuffledSubnetIds;

    for (const [i, subnet] of subnets.entries()) {
      try {
        console.debug(`Attempting to create instance ${runnerParameters.runnerType.instance_type}`);
        // Trying different subnets since some subnets don't always work for specific instance types
        // Tries to resolve for errors like:
        //   Your requested instance type (c5.2xlarge) is not supported in your requested Availability Zone
        // (us-east-1e).
        //   Please retry your request by not specifying an Availability Zone or choosing us-east-1a, us-east-1b,
        //   us-east-1c, us-east-1d, us-east-1f.
        const tags = [
          { Key: 'Application', Value: 'github-action-runner' },
          { Key: 'RunnerType', Value: runnerParameters.runnerType.runnerTypeName },
        ];
        if (runnerParameters.repoName !== undefined) {
          tags.push({
            Key: 'Repo',
            Value: runnerParameters.repoName,
          });
        }
        if (runnerParameters.orgName !== undefined) {
          tags.push({
            Key: 'Org',
            Value: runnerParameters.orgName,
          });
        }

        const runInstancesResponse = await expBackOff(() => {
          return metrics.trackRequest(
            metrics.ec2RunInstancesAWSCallSuccess,
            metrics.ec2RunInstancesAWSCallFailure,
            () => {
              return ec2
                .runInstances({
                  MaxCount: 1,
                  MinCount: 1,
                  LaunchTemplate: {
                    LaunchTemplateName:
                      runnerParameters.runnerType.os === 'linux'
                        ? Config.Instance.launchTemplateNameLinux
                        : Config.Instance.launchTemplateNameWindows,
                    Version:
                      runnerParameters.runnerType.os === 'linux'
                        ? Config.Instance.launchTemplateVersionLinux
                        : Config.Instance.launchTemplateVersionWindows,
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
                      SubnetId: subnet,
                      Groups: Config.Instance.securityGroupIds,
                      DeviceIndex: 0,
                    },
                  ],
                  TagSpecifications: [
                    {
                      ResourceType: 'instance',
                      Tags: tags,
                    },
                  ],
                })
                .promise();
            },
          );
        });

        console.info(
          `Created instance(s) [${runnerParameters.runnerType.runnerTypeName}]: `,
          /* istanbul ignore next */
          runInstancesResponse.Instances?.map((i) => i.InstanceId).join(','),
        );

        await Promise.all(
          /* istanbul ignore next */
          runInstancesResponse.Instances?.map(async (i: EC2.Instance) => {
            await expBackOff(() => {
              return metrics.trackRequest(
                metrics.ssmPutParameterAWSCallSuccess,
                metrics.ssmPutParameterAWSCallFailure,
                () => {
                  return ssm
                    .putParameter({
                      Name: runnerParameters.environment + '-' + (i.InstanceId as string),
                      Value: runnerParameters.runnerConfig,
                      Type: 'SecureString',
                    })
                    .promise();
                },
              );
            });
          }) ?? [],
        );

        // breaks
        break;
      } catch (e) {
        if (i == subnets.length - 1) {
          console.error(
            `[${subnets.length}] Max retries exceeded creating instance ` +
              `${runnerParameters.runnerType.instance_type}: ${e}`,
          );
          throw e;
        } else {
          console.warn(
            `[${i}/${subnets.length}] Issue creating instance ${runnerParameters.runnerType.instance_type}, ` +
              `going to retry :${e}`,
          );
        }
      }
    }
  } catch (e) {
    console.error(`[createRunner]: ${e}`);
    throw e;
  }
}

const ghMainClientCache = new LRU({ maxAge: 10 * 1000 });
const ghClientCache = new LRU({ maxAge: 10 * 1000 });
const ghRunnersCache = new LRU({ maxAge: 30 * 1000 });
const ghTokensCache = new LRU({ maxAge: 60 * 1000 });
const runnerTypeCache = new LRU({ maxAge: 60 * 1000 });

export function resetRunnersCaches() {
  ghClientCache.reset();
  ghMainClientCache.reset();
  ghRunnersCache.reset();
  ghTokensCache.reset();
  runnerTypeCache.reset();
}

async function getGithubClient(metrics: Metrics): Promise<Octokit> {
  try {
    let githubClient: Octokit | undefined = ghMainClientCache.get('client') as Octokit;
    /* istanbul ignore next */
    if (githubClient === undefined) {
      console.debug(`[getGithubClient] Need to instantiate base githubClient`);
      const ghAuth = await createGithubAuth(undefined, 'app', Config.Instance.ghesUrlApi, metrics);
      githubClient = createOctoClient(ghAuth, Config.Instance.ghesUrlApi);
      ghMainClientCache.set('client', githubClient);
    }
    return githubClient;
  } catch (e) {
    console.error(`[getGithubClient]: ${e}`);
    throw e;
  }
}

export async function createGitHubClientForRunnerRepo(repo: Repo, metrics: Metrics): Promise<Octokit> {
  try {
    return await createGitHubClientForRunner(metrics, getRepoKey(repo), async () => {
      try {
        const localGithubClient = await getGithubClient(metrics);
        return await metrics.trackRequest(
          metrics.getRepoInstallationGHCallSuccess,
          metrics.getRepoInstallationGHCallFailure,
          async () => {
            return (await localGithubClient.apps.getRepoInstallation({ ...repo })).data.id;
          },
        );
      } catch (e) {
        console.error(`[createGitHubClientForRunnerRepo <anonymous>]: ${e}`);
        throw e;
      }
    });
  } catch (e) {
    console.error(`[createGitHubClientForRunnerRepo]: ${e}`);
    throw e;
  }
}

export async function createGitHubClientForRunnerOrg(organization: string, metrics: Metrics): Promise<Octokit> {
  try {
    return await createGitHubClientForRunner(metrics, organization, async () => {
      try {
        const localGithubClient = await getGithubClient(metrics);
        return await metrics.trackRequest(
          metrics.getRepoInstallationGHCallSuccess,
          metrics.getRepoInstallationGHCallFailure,
          async () => {
            return (await localGithubClient.apps.getOrgInstallation({ org: organization })).data.id;
          },
        );
      } catch (e) {
        console.error(`[createGitHubClientForRunnerOrg <anonymous>]: ${e}`);
        throw e;
      }
    });
  } catch (e) {
    console.error(`[createGitHubClientForRunnerOrg]: ${e}`);
    throw e;
  }
}

export async function createGitHubClientForRunnerInstallId(installationId: number, metrics: Metrics): Promise<Octokit> {
  try {
    return await createGitHubClientForRunner(metrics, `${installationId}`, async () => {
      return installationId;
    });
  } catch (e) {
    console.error(`[createGitHubClientForRunnerInstallId]: ${e}`);
    throw e;
  }
}

async function createGitHubClientForRunner(
  metrics: Metrics,
  key: string,
  installationIdCallback: () => Promise<number>,
): Promise<Octokit> {
  try {
    const cachedOctokit = ghClientCache.get(key) as Octokit;
    if (cachedOctokit) {
      return cachedOctokit;
    }

    console.debug(`[createGitHubClientForRunner] Cache miss for ${key}`);
    const installationId = await installationIdCallback();
    const ghAuth2 = await createGithubAuth(installationId, 'installation', Config.Instance.ghesUrlApi, metrics);
    const octokit = createOctoClient(ghAuth2, Config.Instance.ghesUrlApi);

    ghClientCache.set(key, octokit);
    return octokit;
  } catch (e) {
    console.error(`[createGitHubClientForRunner]: ${e}`);
    throw e;
  }
}

/**
 * Extract the inner type of a promise if any
 */
type UnboxPromise<T> = T extends Promise<infer U> ? U : T;

export type GhRunners = UnboxPromise<ReturnType<Octokit['actions']['listSelfHostedRunnersForRepo']>>['data']['runners'];

export async function removeGithubRunnerRepo(ec2runner: RunnerInfo, ghRunnerId: number, repo: Repo, metrics: Metrics) {
  try {
    const githubAppClient = await createGitHubClientForRunnerRepo(repo, metrics);
    const result = await metrics.trackRequest(
      metrics.deleteSelfHostedRunnerFromRepoGHCallSuccess,
      metrics.deleteSelfHostedRunnerFromRepoGHCallFailure,
      () => {
        return githubAppClient.actions.deleteSelfHostedRunnerFromRepo({
          ...repo,
          runner_id: ghRunnerId,
        });
      },
    );

    /* istanbul ignore next */
    if (result?.status == 204) {
      await terminateRunner(ec2runner, metrics);
      console.info(
        `AWS runner instance '${ec2runner.instanceId}' [${ec2runner.runnerType}] is terminated ` +
          `and GitHub runner is de-registered. (removeGithubRunnerRepo)`,
      );
    }
  } catch (e) {
    console.warn(
      `Error scaling down (removeGithubRunnerRepo) '${ec2runner.instanceId}' [${ec2runner.runnerType}]: ${e}`,
    );
  }
}

export async function removeGithubRunnerOrg(ec2runner: RunnerInfo, ghRunnerId: number, org: string, metrics: Metrics) {
  try {
    const githubAppClient = await createGitHubClientForRunnerOrg(org, metrics);
    const result = await metrics.trackRequest(
      metrics.deleteSelfHostedRunnerFromOrgGHCallSuccess,
      metrics.deleteSelfHostedRunnerFromOrgGHCallFailure,
      () => {
        return githubAppClient.actions.deleteSelfHostedRunnerFromOrg({
          org: org,
          runner_id: ghRunnerId,
        });
      },
    );

    /* istanbul ignore next */
    if (result?.status == 204) {
      await terminateRunner(ec2runner, metrics);
      console.info(
        `AWS runner instance '${ec2runner.instanceId}' [${ec2runner.runnerType}] is terminated ` +
          `and GitHub runner is de-registered. (removeGithubRunnerOrg)`,
      );
    }
  } catch (e) {
    console.warn(
      `Error scaling down (removeGithubRunnerOrg) '${ec2runner.instanceId}' [${ec2runner.runnerType}]: ${e}`,
    );
  }
}

export async function listGithubRunnersRepo(repo: Repo, metrics: Metrics): Promise<GhRunners> {
  try {
    return await listGithubRunners(getRepoKey(repo), async () => {
      try {
        const client = await createGitHubClientForRunnerRepo(repo, metrics);
        return await metrics.trackRequest(
          metrics.listSelfHostedRunnersForRepoGHCallSuccess,
          metrics.listSelfHostedRunnersForRepoGHCallFailure,
          () => {
            return client.paginate(client.actions.listSelfHostedRunnersForRepo, {
              ...repo,
              per_page: 100,
            });
          },
        );
      } catch (e) {
        console.error(`[listGithubRunnersRepo <anonymous>]: ${e}`);
        throw e;
      }
    });
  } catch (e) {
    console.error(`[listGithubRunnersRepo]: ${e}`);
    throw e;
  }
}

export async function listGithubRunnersOrg(org: string, metrics: Metrics): Promise<GhRunners> {
  try {
    return await listGithubRunners(org, async () => {
      try {
        const client = await createGitHubClientForRunnerOrg(org, metrics);
        return await metrics.trackRequest(
          metrics.listSelfHostedRunnersForOrgGHCallSuccess,
          metrics.listSelfHostedRunnersForOrgGHCallFailure,
          () => {
            return client.paginate(client.actions.listSelfHostedRunnersForOrg, {
              org: org,
              per_page: 100,
            });
          },
        );
      } catch (e) {
        console.error(`[listGithubRunnersOrg <anonymous>]: ${e}`);
        throw e;
      }
    });
  } catch (e) {
    console.error(`[listGithubRunnersOrg]: ${e}`);
    throw e;
  }
}

async function listGithubRunners(key: string, listCallback: () => Promise<GhRunners>): Promise<GhRunners> {
  try {
    const cachedRunners = ghRunnersCache.get(key);
    if (cachedRunners !== undefined) {
      return cachedRunners as GhRunners;
    }

    console.debug(`[listGithubRunners] Cache miss for ${key}`);
    const runners = await listCallback();
    ghRunnersCache.set(key, runners);
    return runners;
  } catch (e) {
    console.error(`[listGithubRunners]: ${e}`);
    throw e;
  }
}

export type GhRunner = UnboxPromise<ReturnType<Octokit['actions']['getSelfHostedRunnerForRepo']>>['data'];

export async function getRunnerRepo(repo: Repo, runnerID: string, metrics: Metrics): Promise<GhRunner | undefined> {
  const client = await createGitHubClientForRunnerRepo(repo, metrics);

  try {
    return (
      await metrics.trackRequest(
        metrics.getSelfHostedRunnerForRepoGHCallSuccess,
        metrics.getSelfHostedRunnerForRepoGHCallFailure,
        () => {
          return client.actions.getSelfHostedRunnerForRepo({
            ...repo,
            runner_id: runnerID as unknown as number,
          });
        },
      )
    ).data;
  } catch (e) {
    console.warn(`[getRunnerRepo <inner try>]: ${e}`);
    return undefined;
  }
}

export async function getRunnerOrg(org: string, runnerID: string, metrics: Metrics): Promise<GhRunner | undefined> {
  const client = await createGitHubClientForRunnerOrg(org, metrics);

  try {
    return (
      await metrics.trackRequest(
        metrics.getSelfHostedRunnerForOrgGHCallSuccess,
        metrics.getSelfHostedRunnerForOrgGHCallFailure,
        () => {
          return client.actions.getSelfHostedRunnerForOrg({
            org: org,
            runner_id: runnerID as unknown as number,
          });
        },
      )
    ).data;
  } catch (e) {
    console.warn(`[getRunnerOrg <inner try>]: ${e}`);
    return undefined;
  }
}

export async function getRunnerTypes(
  repo: Repo,
  metrics: Metrics,
  filepath = Config.Instance.scaleConfigRepoPath,
): Promise<Map<string, RunnerType>> {
  let status = 'noRun';
  try {
    const runnerTypeKey = getRepoKey(repo);

    if (runnerTypeCache.get(runnerTypeKey) !== undefined) {
      return runnerTypeCache.get(runnerTypeKey) as Map<string, RunnerType>;
    }
    console.debug(`[getRunnerTypes] cache miss for ${runnerTypeKey}`);

    status = 'doRun';
    /* istanbul ignore next */
    const githubAppClient = Config.Instance.enableOrganizationRunners
      ? await createGitHubClientForRunnerOrg(repo.owner, metrics)
      : await createGitHubClientForRunnerRepo(repo, metrics);

    const response = await metrics.trackRequest(
      metrics.reposGetContentGHCallSuccess,
      metrics.reposGetContentGHCallFailure,
      () => {
        return githubAppClient.repos.getContent({
          ...repo,
          path: filepath,
        });
      },
    );

    /* istanbul ignore next */
    const { content } = { ...(response?.data || {}) };

    /* istanbul ignore next */
    if (response?.status != 200 || !content) {
      throw Error(
        `Issue (${response.status}) retrieving '${filepath}' ` + `for https://github.com/${repo.owner}/${repo.repo}/`,
      );
    }

    const buff = Buffer.from(content, 'base64');
    const configYml = buff.toString('ascii');

    console.debug(`'${filepath}' contents: ${configYml}`);

    const config = YAML.parse(configYml);
    const result: Map<string, RunnerType> = new Map(
      /* eslint-disable @typescript-eslint/no-explicit-any */
      (Object.entries(config.runner_types) as [string, any][]).map(([prop, runner_type]) => [
        prop,
        {
          runnerTypeName: prop,
          instance_type: runner_type.instance_type,
          os: runner_type.os,
          max_available: runner_type.max_available,
          disk_size: runner_type.disk_size,
          /* istanbul ignore next */
          is_ephemeral: runner_type.is_ephemeral || false,
        },
      ]),
    );

    runnerTypeCache.set(runnerTypeKey, result);
    console.debug(`configuration: ${JSON.stringify(result)}`);

    status = 'success';
    return result;
  } catch (e) {
    console.error(`[getRunnerTypes]: ${e}`);
    throw e;
  } finally {
    if (status == 'doRun') {
      metrics.getRunnerTypesFailure();
    } else if (status == 'success') {
      metrics.getRunnerTypesSuccess();
    }
  }
}

export async function createRegistrationTokenRepo(
  repo: Repo,
  metrics: Metrics,
  installationId?: number,
): Promise<string> {
  try {
    return await createRegistrationToken(getRepoKey(repo), async () => {
      try {
        const githubInstallationClient = installationId
          ? await createGitHubClientForRunnerInstallId(installationId, metrics)
          : await createGitHubClientForRunnerRepo(repo, metrics);
        const response = await metrics.trackRequest(
          metrics.createRegistrationTokenForRepoGHCallSuccess,
          metrics.createRegistrationTokenForRepoGHCallFailure,
          () => {
            return githubInstallationClient.actions.createRegistrationTokenForRepo({ ...repo });
          },
        );

        /* istanbul ignore next */
        if (response?.status != 201 || !response.data?.token) {
          throw Error(
            `[createRegistrationTokenRepo] Issue (${response.status}) retrieving registration token ` +
              `for https://github.com/${repo.owner}/${repo.repo}/`,
          );
        }
        return response.data.token;
      } catch (e) {
        console.error(`[createRegistrationTokenRepo <anonymous>]: ${e}`);
        throw e;
      }
    });
  } catch (e) {
    console.error(`[createRegistrationTokenRepo]: ${e}`);
    throw e;
  }
}

export async function createRegistrationTokenOrg(
  org: string,
  metrics: Metrics,
  installationId?: number,
): Promise<string> {
  try {
    return await createRegistrationToken(org, async () => {
      try {
        const githubInstallationClient = installationId
          ? await createGitHubClientForRunnerInstallId(installationId, metrics)
          : await createGitHubClientForRunnerOrg(org, metrics);
        const response = await metrics.trackRequest(
          metrics.createRegistrationTokenForOrgGHCallSuccess,
          metrics.createRegistrationTokenForOrgGHCallFailure,
          () => {
            return githubInstallationClient.actions.createRegistrationTokenForOrg({ org: org });
          },
        );
        /* istanbul ignore next */
        if (response?.status != 201 || !response.data?.token) {
          throw Error(
            `[createRegistrationTokenOrg] Issue (${response.status}) retrieving registration token ` +
              `for https://github.com/${org}/`,
          );
        }
        return response.data.token;
      } catch (e) {
        console.error(`[createRegistrationTokenOrg <anonymous>]: ${e}`);
        throw e;
      }
    });
  } catch (e) {
    console.error(`[createRegistrationTokenOrg]: ${e}`);
    throw e;
  }
}

async function createRegistrationToken(key: string, getKey: () => Promise<string>): Promise<string> {
  try {
    if (ghTokensCache.get(key) !== undefined) {
      return ghTokensCache.get(key) as string;
    }

    console.debug(`[createRegistrationToken] cache miss for ${key}`);
    const token = await getKey();
    ghTokensCache.set(key, token);
    return token;
  } catch (e) {
    console.error(`[createRegistrationToken]: ${e}`);
    throw e;
  }
}

import { EC2, SSM } from 'aws-sdk';
import { RunnerInfo, expBackOff } from './utils';

import { Config } from './config';
import LRU from 'lru-cache';
import { Metrics } from './metrics';

export interface ListRunnerFilters {
  repoName?: string;
  orgName?: string;
  environment?: string;
}

export interface RunnerInputParameters {
  runnerConfig: string;
  environment: string;
  repoName?: string;
  orgName?: string;
  runnerType: RunnerType;
}

export interface RunnerType {
  instance_type: string;
  os: string;
  max_available: number;
  disk_size: number;
  runnerTypeName: string;
  is_ephemeral: boolean;
}

const SHOULD_NOT_TRY_LIST_SSM = 'SHOULD_NOT_TRY_LIST_SSM';

// Keep the cache as long as half of minimum time, this should reduce calls to AWS API
const ssmParametersCache = new LRU({ maxAge: (Config.Instance.minimumRunningTimeInMinutes * 60 * 1000) / 2 });

export function resetRunnersCaches() {
  ssmParametersCache.reset();
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

export function getParameterNameForRunner(environment: string, instanceId: string): string {
  return `${environment}-${instanceId}`;
}

export async function listSSMParameters(metrics: Metrics): Promise<Set<string>> {
  const key = 'notUsedNow';

  let parametersSet: Set<string> = ssmParametersCache.get(key) as Set<string>;

  if (parametersSet === undefined) {
    parametersSet = new Set();
    const ssm = new SSM();
    let nextToken: string | undefined = undefined;

    do {
      const response = await expBackOff(() => {
        return metrics.trackRequest(
          metrics.ssmDescribeParametersAWSCallSuccess,
          metrics.ssmDescribeParametersAWSCallFailure,
          () => {
            if (nextToken) {
              const reqParam: SSM.DescribeParametersRequest = { NextToken: nextToken };
              return ssm.describeParameters(reqParam).promise();
            }
            return ssm.describeParameters().promise();
          },
        );
      });
      nextToken = response.NextToken;
      /* istanbul ignore next */
      response.Parameters?.forEach((metadata) => {
        /* istanbul ignore next */
        if (metadata.Name) {
          parametersSet.add(metadata.Name);
        }
      });
    } while (nextToken);

    ssmParametersCache.set(key, parametersSet);
  }

  return parametersSet;
}

async function doDeleteSSMParameter(paramName: string, metrics: Metrics): Promise<void> {
  try {
    const ssm = new SSM();
    await expBackOff(() => {
      return metrics.trackRequest(
        metrics.ssmdeleteParameterAWSCallSuccess,
        metrics.ssmdeleteParameterAWSCallFailure,
        () => {
          return ssm.deleteParameter({ Name: paramName }).promise();
        },
      );
    });
  } catch (e) {
    console.error(`[terminateRunner - SSM.deleteParameter] Failed deleting parameter ${paramName}: ${e}`);
  }
}

export async function terminateRunner(runner: RunnerInfo, metrics: Metrics): Promise<void> {
  try {
    const ec2 = new EC2();

    await expBackOff(() => {
      return metrics.trackRequest(
        metrics.ec2TerminateInstancesAWSCallSuccess,
        metrics.ec2TerminateInstancesAWSCallFailure,
        () => {
          return ec2.terminateInstances({ InstanceIds: [runner.instanceId] }).promise();
        },
      );
    });
    console.info(`Runner terminated: ${runner.instanceId} ${runner.runnerType}`);

    const paramName = getParameterNameForRunner(runner.environment || Config.Instance.environment, runner.instanceId);

    if (ssmParametersCache.has(SHOULD_NOT_TRY_LIST_SSM)) {
      doDeleteSSMParameter(paramName, metrics);
    } else {
      try {
        const params = await listSSMParameters(metrics);

        if (params.has(paramName)) {
          doDeleteSSMParameter(paramName, metrics);
          console.info(`Parameter deleted: ${paramName}`);
        } else {
          /* istanbul ignore next */
          console.info(`Parameter "${paramName}" not found in SSM, no need to delete it`);
        }
      } catch (e) {
        ssmParametersCache.set(SHOULD_NOT_TRY_LIST_SSM, 1, 60 * 1000);
        console.error(`[terminateRunner - listSSMParameters] Failed to list parameters or check if available: ${e}`);
      }
    }
  } catch (e) {
    console.error(`[terminateRunner]: ${e}`);
    throw e;
  }
}

async function addSSMParameterRunnerConfig(
  instances: EC2.InstanceList,
  runnerParameters: RunnerInputParameters,
  ssm: SSM,
  metrics: Metrics,
): Promise<void> {
  const createdSSMParams = await Promise.all(
    /* istanbul ignore next */
    instances.map(async (i: EC2.Instance) => {
      const parameterName = getParameterNameForRunner(runnerParameters.environment, i.InstanceId as string);
      return await expBackOff(() => {
        return metrics.trackRequest(
          metrics.ssmPutParameterAWSCallSuccess,
          metrics.ssmPutParameterAWSCallFailure,
          async () => {
            await ssm
              .putParameter({
                Name: parameterName,
                Value: runnerParameters.runnerConfig,
                Type: 'SecureString',
              })
              .promise();
            return parameterName;
          },
        );
      });
    }) ?? [],
  );
  console.debug(`Created SSM Parameters(s): ${createdSSMParams.join(',')}`);
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

        if (runInstancesResponse.Instances) {
          console.info(
            `Created instance(s) [${runnerParameters.runnerType.runnerTypeName}]: `,
            runInstancesResponse.Instances.map((i) => i.InstanceId).join(','),
          );
          addSSMParameterRunnerConfig(runInstancesResponse.Instances, runnerParameters, ssm, metrics);
        }

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

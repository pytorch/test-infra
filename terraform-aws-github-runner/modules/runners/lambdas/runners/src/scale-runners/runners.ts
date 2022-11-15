import { EC2, SSM } from 'aws-sdk';
import { PromiseResult } from 'aws-sdk/lib/request';
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

export interface DescribeInstancesResultRegion {
  awsRegion: string;
  describeInstanceResult: PromiseResult<EC2.Types.DescribeInstancesResult, AWS.AWSError>;
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
    const runningInstances = (
      await Promise.all(
        Config.Instance.awsRegionInstances.map((awsRegion) => {
          return expBackOff(() => {
            return metrics.trackRequestRegion(
              awsRegion,
              metrics.ec2DescribeInstancesAWSCallSuccess,
              metrics.ec2DescribeInstancesAWSCallFailure,
              () => {
                return new EC2({ region: awsRegion })
                  .describeInstances({ Filters: ec2Filters })
                  .promise()
                  .then((describeInstanceResult): DescribeInstancesResultRegion => {
                    return { describeInstanceResult, awsRegion };
                  });
              },
            );
          });
        }),
      )
    ).flat();
    /* istanbul ignore next */
    return runningInstances.flatMap((itm) => {
      return (
        itm.describeInstanceResult?.Reservations?.flatMap((reservation) => {
          /* istanbul ignore next */
          return (
            reservation.Instances?.map((instance) => ({
              awsRegion: itm.awsRegion,
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
    });
  } catch (e) {
    console.error(`[listRunners]: ${e}`);
    throw e;
  }
}

export function getParameterNameForRunner(environment: string, instanceId: string): string {
  return `${environment}-${instanceId}`;
}

export async function listSSMParameters(metrics: Metrics, awsRegion: string): Promise<Set<string>> {
  let parametersSet: Set<string> = ssmParametersCache.get(awsRegion) as Set<string>;

  if (parametersSet === undefined) {
    parametersSet = new Set();
    const ssm = new SSM({ region: awsRegion });
    let nextToken: string | undefined = undefined;

    do {
      const response = await expBackOff(() => {
        return metrics.trackRequestRegion(
          awsRegion,
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

    ssmParametersCache.set(awsRegion, parametersSet);
  }

  return parametersSet;
}

async function doDeleteSSMParameter(paramName: string, metrics: Metrics, awsRegion: string): Promise<void> {
  try {
    const ssm = new SSM({ region: awsRegion });
    await expBackOff(() => {
      return metrics.trackRequestRegion(
        awsRegion,
        metrics.ssmdeleteParameterAWSCallSuccess,
        metrics.ssmdeleteParameterAWSCallFailure,
        () => {
          return ssm.deleteParameter({ Name: paramName }).promise();
        },
      );
    });
  } catch (e) {
    console.error(
      `[terminateRunner - SSM.deleteParameter] [${awsRegion}] Failed ` + `deleting parameter ${paramName}: ${e}`,
    );
  }
}

export async function terminateRunner(runner: RunnerInfo, metrics: Metrics, awsRegion: string): Promise<void> {
  try {
    const ec2 = new EC2({ region: awsRegion });

    await expBackOff(() => {
      return metrics.trackRequestRegion(
        awsRegion,
        metrics.ec2TerminateInstancesAWSCallSuccess,
        metrics.ec2TerminateInstancesAWSCallFailure,
        () => {
          return ec2.terminateInstances({ InstanceIds: [runner.instanceId] }).promise();
        },
      );
    });
    console.info(`Runner terminated: ${runner.instanceId} ${runner.runnerType}`);

    const paramName = getParameterNameForRunner(runner.environment || Config.Instance.environment, runner.instanceId);
    const cacheName = `${SHOULD_NOT_TRY_LIST_SSM}_${awsRegion}`;

    if (ssmParametersCache.has(cacheName)) {
      doDeleteSSMParameter(paramName, metrics, awsRegion);
    } else {
      try {
        const params = await listSSMParameters(metrics, awsRegion);

        if (params.has(paramName)) {
          doDeleteSSMParameter(paramName, metrics, awsRegion);
          console.info(`[${awsRegion}] Parameter deleted: ${paramName}`);
        } else {
          /* istanbul ignore next */
          console.info(`[${awsRegion}] Parameter "${paramName}" not found in SSM, no need to delete it`);
        }
      } catch (e) {
        ssmParametersCache.set(cacheName, 1, 60 * 1000);
        console.error(
          `[terminateRunner - listSSMParameters] [${awsRegion}] ` +
            `Failed to list parameters or check if available: ${e}`,
        );
      }
    }
  } catch (e) {
    console.error(`[${awsRegion}] [terminateRunner]: ${e}`);
    throw e;
  }
}

async function addSSMParameterRunnerConfig(
  instances: EC2.InstanceList,
  runnerParameters: RunnerInputParameters,
  ssm: SSM,
  metrics: Metrics,
  awsRegion: string,
): Promise<void> {
  const createdSSMParams = await Promise.all(
    /* istanbul ignore next */
    instances.map(async (i: EC2.Instance) => {
      // i.
      const parameterName = getParameterNameForRunner(runnerParameters.environment, i.InstanceId as string);
      return await expBackOff(() => {
        return metrics.trackRequestRegion(
          awsRegion,
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
  console.debug(`[${awsRegion}] Created SSM Parameters(s): ${createdSSMParams.join(',')}`);
}

function getLaunchTemplateName(runnerParameters: RunnerInputParameters): Array<string | undefined> {
  if (runnerParameters.runnerType.os === 'linux') {
    if (runnerParameters.runnerType.runnerTypeName.includes('.nvidia.gpu')) {
      return [Config.Instance.launchTemplateNameLinuxNvidia, Config.Instance.launchTemplateVersionLinuxNvidia];
    } else {
      return [Config.Instance.launchTemplateNameLinux, Config.Instance.launchTemplateVersionLinux];
    }
  } else {
    return [Config.Instance.launchTemplateNameWindows, Config.Instance.launchTemplateVersionWindows];
  }
}

export async function createRunner(runnerParameters: RunnerInputParameters, metrics: Metrics): Promise<string> {
  try {
    console.debug('Runner configuration: ' + JSON.stringify(runnerParameters));

    const storageDeviceName = runnerParameters.runnerType.os === 'linux' ? '/dev/xvda' : '/dev/sda1';
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
    const [launchTemplateName, launchTemplateVersion] = getLaunchTemplateName(runnerParameters);

    for (const awsRegion of Config.Instance.shuffledAwsRegionInstances) {
      const ec2 = new EC2({ region: awsRegion });
      const ssm = new SSM({ region: awsRegion });
      const subnets = Config.Instance.shuffledSubnetIdsForAwsRegion(awsRegion);
      for (const [i, subnet] of subnets.entries()) {
        try {
          console.debug(`[${awsRegion}] Attempting to create instance ${runnerParameters.runnerType.instance_type}`);
          const runInstancesResponse = await expBackOff(() => {
            return metrics.trackRequestRegion(
              awsRegion,
              metrics.ec2RunInstancesAWSCallSuccess,
              metrics.ec2RunInstancesAWSCallFailure,
              () => {
                return ec2
                  .runInstances({
                    MaxCount: 1,
                    MinCount: 1,
                    LaunchTemplate: {
                      LaunchTemplateName: launchTemplateName,
                      Version: launchTemplateVersion,
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
              `Created instance(s) [${awsRegion}] [${runnerParameters.runnerType.runnerTypeName}]: `,
              runInstancesResponse.Instances.map((i) => i.InstanceId).join(','),
            );
            addSSMParameterRunnerConfig(runInstancesResponse.Instances, runnerParameters, ssm, metrics, awsRegion);
          }

          // breaks
          return awsRegion;
        } catch (e) {
          if (i == subnets.length - 1) {
            console.error(
              `[${subnets.length}] [${awsRegion}] Max retries exceeded creating instance ` +
                `${runnerParameters.runnerType.instance_type}: ${e}`,
            );
            throw e;
          } else {
            console.warn(
              `[${i}/${subnets.length}] [${awsRegion}] Issue creating instance ` +
                `${runnerParameters.runnerType.instance_type}, ` +
                `going to retry :${e}`,
            );
          }
        }
      }
    }
    throw Error('Should never get here, but this should silence false linting errors');
  } catch (e) {
    console.error(`[createRunner]: ${e}`);
    throw e;
  }
}

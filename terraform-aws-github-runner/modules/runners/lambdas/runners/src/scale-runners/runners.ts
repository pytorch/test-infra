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
  runnerConfig: (awsRegion: string) => Promise<string>;
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
  ami?: string;
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
    console.debug(`[listRunners]: REGIONS ${Config.Instance.shuffledAwsRegionInstances}`);
    const runningInstances = (
      await Promise.all(
        Config.Instance.shuffledAwsRegionInstances.map((awsRegion) => {
          console.debug(`[listRunners]: Running for region ${awsRegion}`);
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
                    console.debug(
                      `[listRunners]: Result for EC2({ region: ${awsRegion} })` +
                        `.describeInstances({ Filters: ${ec2Filters} }) = ` +
                        `${describeInstanceResult?.Reservations?.length ?? 'UNDEF'}`,
                    );
                    return { describeInstanceResult, awsRegion };
                  });
              },
            );
          });
        }),
      )
    ).flat();
    console.debug(`[listRunners]: runningInstances = ${runningInstances.length}`);
    /* istanbul ignore next */
    return runningInstances.flatMap((itm) => {
      return (
        itm.describeInstanceResult?.Reservations?.flatMap((reservation) => {
          /* istanbul ignore next */
          return (
            reservation.Instances?.map((instance) => ({
              applicationDeployDatetime: instance.Tags?.find((e) => e.Key === 'ApplicationDeployDatetime')?.Value,
              awsRegion: itm.awsRegion,
              environment: instance.Tags?.find((e) => e.Key === 'Environment')?.Value,
              ghRunnerId: instance.Tags?.find((e) => e.Key === 'GithubRunnerID')?.Value,
              instanceId: instance.InstanceId as string,
              launchTime: instance.LaunchTime,
              org: instance.Tags?.find((e) => e.Key === 'Org')?.Value,
              repo: instance.Tags?.find((e) => e.Key === 'Repo')?.Value,
              runnerType: instance.Tags?.find((e) => e.Key === 'RunnerType')?.Value,
              instanceManagement: instance.Tags?.find((e) => e.Key == 'InstanceManagement')?.Value,
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
    console.info(`[${awsRegion}] Parameter deleted: ${paramName}`);
  } catch (e) {
    /* istanbul ignore next */
    console.error(
      `[terminateRunner - SSM.deleteParameter] [${awsRegion}] Failed ` + `deleting parameter ${paramName}: ${e}`,
    );
  }
}

export async function terminateRunner(runner: RunnerInfo, metrics: Metrics): Promise<void> {
  try {
    const ec2 = new EC2({ region: runner.awsRegion });

    await expBackOff(() => {
      return metrics.trackRequestRegion(
        runner.awsRegion,
        metrics.ec2TerminateInstancesAWSCallSuccess,
        metrics.ec2TerminateInstancesAWSCallFailure,
        () => {
          return ec2.terminateInstances({ InstanceIds: [runner.instanceId] }).promise();
        },
      );
    });
    console.info(`Runner terminated: ${runner.instanceId} ${runner.runnerType}`);

    const paramName = getParameterNameForRunner(runner.environment || Config.Instance.environment, runner.instanceId);
    const cacheName = `${SHOULD_NOT_TRY_LIST_SSM}_${runner.awsRegion}`;

    if (ssmParametersCache.has(cacheName)) {
      doDeleteSSMParameter(paramName, metrics, runner.awsRegion);
    } else {
      try {
        const params = await listSSMParameters(metrics, runner.awsRegion);

        if (params.has(paramName)) {
          doDeleteSSMParameter(paramName, metrics, runner.awsRegion);
        } else {
          /* istanbul ignore next */
          console.info(`[${runner.awsRegion}] Parameter "${paramName}" not found in SSM, no need to delete it`);
        }
      } catch (e) {
        ssmParametersCache.set(cacheName, 1, 60 * 1000);
        console.error(
          `[terminateRunner - listSSMParameters] [${runner.awsRegion}] ` +
            `Failed to list parameters or check if available: ${e}`,
        );
        doDeleteSSMParameter(paramName, metrics, runner.awsRegion);
      }
    }
  } catch (e) {
    console.error(`[${runner.awsRegion}] [terminateRunner]: ${e}`);
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
  /* istanbul ignore next */
  if (instances.length == 0) {
    console.debug(`[${awsRegion}] No SSM parameter to be created, empty list of instances`);
    return;
  }
  const runnerConfig = await runnerParameters.runnerConfig(awsRegion);
  const createdSSMParams = await Promise.all(
    /* istanbul ignore next */
    instances.map(async (i: EC2.Instance) => {
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
                Value: runnerConfig,
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
    if (runnerParameters.runnerType.runnerTypeName.includes('.arm64') {
      return [Config.Instance.launchTemplateNameLinuxARM64, Config.Instance.launchTemplateVersionLinuxARM64];
    } else if (runnerParameters.runnerType.runnerTypeName.includes('.nvidia.gpu')) {
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
    /* istanbul ignore next */
    if (Config.Instance.datetimeDeploy) {
      tags.push({ Key: 'ApplicationDeployDatetime', Value: Config.Instance.datetimeDeploy });
    }
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
    const errors: Array<[string, unknown, string]> = [];

    const shuffledAwsRegionInstances = Config.Instance.shuffledAwsRegionInstances;
    for (const [awsRegionIdx, awsRegion] of shuffledAwsRegionInstances.entries()) {
      const ec2 = new EC2({ region: awsRegion });
      const ssm = new SSM({ region: awsRegion });
      const shuffledVPCsForAwsRegion = Config.Instance.shuffledVPCsForAwsRegion(awsRegion);
      for (const [vpcIdIdx, vpcId] of shuffledVPCsForAwsRegion.entries()) {
        const securityGroupIds = Config.Instance.vpcIdToSecurityGroupIds.get(vpcId) ?? [];
        const subnets = Config.Instance.shuffledSubnetsForVpcId(vpcId);
        for (const [subnetIdx, subnet] of subnets.entries()) {
          try {
            console.debug(
              `[${awsRegion}] [${vpcId}] Attempting to create instance ${runnerParameters.runnerType.instance_type}`,
            );
            const runInstancesResponse = await expBackOff(() => {
              return metrics.trackRequestRegion(
                awsRegion,
                metrics.ec2RunInstancesAWSCallSuccess,
                metrics.ec2RunInstancesAWSCallFailure,
                () => {
                  const params: EC2.RunInstancesRequest = {
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
                        Ipv6AddressCount: 1,
                        AssociatePublicIpAddress: true,
                        SubnetId: subnet,
                        Groups: securityGroupIds,
                        DeviceIndex: 0,
                      },
                    ],
                    TagSpecifications: [
                      {
                        ResourceType: 'instance',
                        Tags: tags,
                      },
                    ],
                  };
                  if (runnerParameters.runnerType.ami) {
                    params.ImageId = runnerParameters.runnerType.ami;
                  }
                  return ec2.runInstances(params).promise();
                },
              );
            });

            if (runInstancesResponse.Instances && runInstancesResponse.Instances.length > 0) {
              console.info(
                `Created instance(s) [${awsRegion}] [${vpcId}] [${runnerParameters.runnerType.runnerTypeName}]: `,
                runInstancesResponse.Instances.map((i) => i.InstanceId).join(','),
              );
              addSSMParameterRunnerConfig(runInstancesResponse.Instances, runnerParameters, ssm, metrics, awsRegion);

              // breaks
              return awsRegion;
            } else {
              const msg =
                `[${awsRegion}] [${vpcId}] [${runnerParameters.runnerType.instance_type}] ` +
                `[${runnerParameters.runnerType.runnerTypeName}] ec2.runInstances returned empty list of instaces ` +
                `created, but exit without throwing any exception (?!?!?!)`;
              errors.push([msg, undefined, awsRegion]);
              console.warn(msg);
            }
          } catch (e) {
            const msg =
              `[${subnetIdx}/${subnets.length} - ${subnet}] ` +
              `[${vpcIdIdx}/${shuffledVPCsForAwsRegion.length} - ${vpcId}] ` +
              `[${awsRegionIdx}/${shuffledAwsRegionInstances.length} - ${awsRegion}] Issue creating instance ` +
              `${runnerParameters.runnerType.instance_type}: ${e}`;
            errors.push([msg, e, awsRegion]);
            console.warn(msg);
          }
        }
      }
    }
    if (errors.length) {
      const errsCount: Map<string, number> = new Map();
      /* istanbul ignore next */
      errors.forEach((err) => {
        let key = 'undefined';
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          key = (err[1] as any).name;
        } catch (e) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            key = (err[1] as any).code;
          } catch (e) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              key = (err[1] as any).constructor.name;
            } catch (e) {
              try {
                key = typeof err[1];
              } catch (e) {
                console.debug(`could not get a type for ${err[1]}`);
              }
            }
          }
        }
        errsCount.set(key, (errsCount.get(key) ?? 0) + 1);
        metrics.ec2RunInstancesAWSCallException(runnerParameters.runnerType.instance_type, err[2], key);
      });
      let excSumm = '';
      errsCount.forEach((count, excep) => {
        excSumm += ` "${excep}": ${count},`;
      });
      throw new Error(
        `[${runnerParameters.runnerType.instance_type}] Giving up creating instance, all regions, ` +
          `availability zones and subnets failed. Total exceptions: ${errors.length}; Exceptions count:${excSumm}`,
      );
    } else {
      /* istanbul ignore next */
      throw new Error(
        `[${runnerParameters.runnerType.instance_type}] Failed to runInstances without any exception captured! ` +
          `Check AWS_REGIONS_TO_VPC_IDS, VPC_ID_TO_SECURITY_GROUP_IDS and VPC_ID_TO_SUBNET_IDS environment variables!`,
      );
    }
  } catch (e) {
    console.error(`[createRunner]: ${e}`);
    throw e;
  }
}

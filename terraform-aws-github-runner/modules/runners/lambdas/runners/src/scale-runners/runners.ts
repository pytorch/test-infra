import { EC2, SSM } from 'aws-sdk';
import { PromiseResult } from 'aws-sdk/lib/request';
import { RunnerInfo, expBackOff, shuffleArrayInPlace } from './utils';

import { Config } from './config';
import LRU from 'lru-cache';
import { Metrics } from './metrics';
import { redisCached } from './cache';

export interface ListRunnerFilters {
  repoName?: string;
  orgName?: string;
  environment?: string;
  instanceType?: string;
}

export interface RunnerInputParameters {
  runnerConfig: (awsRegion: string, experimentalRunner: boolean) => Promise<string>;
  environment: string;
  repoName?: string;
  orgName?: string;
  runnerType: RunnerType;
}

export interface AmiExpermient {
  ami: string;
  percentage: number;
}

export interface RunnerTypeOptional {
  ami_experiment?: AmiExpermient;
  ami?: string;
  disk_size?: number;
  instance_type?: string;
  is_ephemeral?: boolean;
  labels?: Array<string>;
  min_available?: number;
  max_available?: number;
  os?: string;
}

export interface RunnerType extends RunnerTypeOptional {
  disk_size: number;
  instance_type: string;
  is_ephemeral: boolean;
  max_available: number;
  os: string;
  runnerTypeName: string;
}

export interface RunnerTypeScaleConfig extends RunnerType {
  variants?: Map<string, RunnerTypeOptional>;
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

export async function findAmiID(metrics: Metrics, region: string, filter: string, owners = 'amazon'): Promise<string> {
  const ec2 = new EC2({ region: region });
  const filters = [
    { Name: 'name', Values: [filter] },
    { Name: 'state', Values: ['available'] },
  ];
  return redisCached('awsEC2', `findAmiID-${region}-${filter}-${owners}`, 10 * 60, 0.5, () => {
    return expBackOff(() => {
      return metrics.trackRequestRegion(
        region,
        metrics.ec2DescribeImagesSuccess,
        metrics.ec2DescribeImagesFailure,
        () => {
          return ec2
            .describeImages({ Owners: [owners], Filters: filters })
            .promise()
            .then((data: EC2.DescribeImagesResult) => {
              /* istanbul ignore next */
              if (data.Images?.length === 0) {
                console.error(`No availabe images found for filter '${filter}'`);
                throw new Error(`No availabe images found for filter '${filter}'`);
              }
              sortByCreationDate(data);
              return data.Images?.shift()?.ImageId as string;
            });
        },
      );
    });
  });
}

// Shamelessly stolen from https://ajahne.github.io/blog/javascript/aws/2019/05/15/getting-an-ami-id-nodejs.html
function sortByCreationDate(data: EC2.DescribeImagesResult): void {
  const images = data.Images as EC2.ImageList;
  images.sort(function (a: EC2.Image, b: EC2.Image) {
    const dateA: string = a['CreationDate'] as string;
    const dateB: string = b['CreationDate'] as string;
    if (dateA < dateB) {
      return -1;
    }
    if (dateA > dateB) {
      return 1;
    }
    // dates are equal
    return 0;
  });

  // arrange the images by date in descending order
  images.reverse();
}

export async function listRunners(
  metrics: Metrics,
  filters: ListRunnerFilters | undefined = undefined,
  regions: Set<string> | undefined = undefined,
): Promise<RunnerInfo[]> {
  try {
    const ec2Filters = [
      { Name: 'tag:Application', Values: ['github-action-runner'] },
      { Name: 'instance-state-name', Values: ['running', 'pending'] },
    ];
    if (filters) {
      if (filters.instanceType) {
        ec2Filters.push({
          Name: 'instance-type',
          Values: [filters.instanceType],
        });
      }

      const tags = {
        environment: 'tag:Environment',
        repoName: 'tag:Repo',
        orgName: 'tag:Org',
      };
      (Object.keys(tags) as Array<keyof typeof filters>)
        .filter((attr) => filters[attr] !== undefined)
        .filter((attr) => attr in tags)
        .forEach((attr) =>
          ec2Filters.push({ Name: tags[attr as keyof typeof tags], Values: [filters[attr] as string] }),
        );
    }
    console.debug(`[listRunners]: REGIONS ${Config.Instance.shuffledAwsRegionInstances}`);
    const runningInstances = (
      await Promise.all(
        Config.Instance.shuffledAwsRegionInstances
          .filter((r) => regions?.has(r) ?? true)
          .map((awsRegion) => {
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
              az: instance.Placement?.AvailabilityZone?.toLocaleLowerCase(),
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

export async function listSSMParameters(
  metrics: Metrics,
  awsRegion: string,
): Promise<Map<string, SSM.ParameterMetadata>> {
  let parametersSet: Map<string, SSM.ParameterMetadata> = ssmParametersCache.get(awsRegion) as Map<
    string,
    SSM.ParameterMetadata
  >;

  if (parametersSet === undefined) {
    parametersSet = new Map<string, SSM.ParameterMetadata>();
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
        if (metadata.Name !== undefined && metadata.Name.startsWith(`${Config.Instance.environment}-i`)) {
          parametersSet.set(metadata.Name, metadata);
        }
      });
    } while (nextToken);

    ssmParametersCache.set(awsRegion, parametersSet);
  }

  return parametersSet;
}

export async function doDeleteSSMParameter(paramName: string, metrics: Metrics, awsRegion: string): Promise<boolean> {
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
    console.debug(`[${awsRegion}] Parameter deleted: ${paramName}`);
    return true;
  } catch (e) {
    /* istanbul ignore next */
    console.error(
      `[terminateRunner - SSM.deleteParameter] [${awsRegion}] Failed ` + `deleting parameter ${paramName}: ${e}`,
    );
    /* istanbul ignore next */
    return false;
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
  customAmiExperiment: boolean,
  ssm: SSM,
  metrics: Metrics,
  awsRegion: string,
): Promise<void> {
  /* istanbul ignore next */
  if (instances.length == 0) {
    console.debug(`[${awsRegion}] No SSM parameter to be created, empty list of instances`);
    return;
  }

  let runnerConfig = await runnerParameters.runnerConfig(awsRegion, customAmiExperiment);
  if (customAmiExperiment) {
    runnerConfig = `${runnerConfig} #ON_AMI_EXPERIMENT`;
  }

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
    /* istanbul ignore next */
    if (runnerParameters.runnerType.runnerTypeName.includes('.arm64')) {
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

async function getCreateRunnerSubnetSequence(
  runnerParameters: RunnerInputParameters,
  region: string,
  metrics: Metrics,
): Promise<Array<string>> {
  const azs = Array.from(new Set(Config.Instance.subnetIdToAZ.values()).values());
  const azCounts: Map<string, number> = new Map(azs.map((az) => [az, 0]));

  try {
    const filters: ListRunnerFilters = {
      environment: runnerParameters.environment,
      instanceType: runnerParameters.runnerType.instance_type,
    };
    (await listRunners(metrics, filters, new Set([region]))).forEach((runner) => {
      if (runner.az !== undefined && azCounts.has(runner.az)) {
        azCounts.set(runner.az, (azCounts.get(runner.az) ?? 0) + 1);
      }
    });
  } catch (e) {
    /* istanbul ignore next */
    console.error(`[getCreateRunnerSubnetSequence] Failed to list runners: ${e}`);
  }

  const vpcGroupedByCounts: Map<number, Array<string>> = new Map();
  azCounts.forEach((count, az) => {
    if (!vpcGroupedByCounts.has(count)) {
      vpcGroupedByCounts.set(count, []);
    }
    Config.Instance.azToSubnetIds.get(az)?.forEach((subnetId) => {
      vpcGroupedByCounts.get(count)?.push(subnetId);
    });
  });

  return Array.from(vpcGroupedByCounts.keys())
    .sort((a, b) => a - b)
    .map((count) => {
      return shuffleArrayInPlace(vpcGroupedByCounts.get(count) ?? []);
    })
    .flat();
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
    let customAmi = runnerParameters.runnerType.ami;
    let customAmiExperiment = false;
    if (runnerParameters.runnerType.ami_experiment) {
      console.info(`[createRunner]: Using AMI experiment for ${runnerParameters.runnerType.runnerTypeName}`);
      if (runnerParameters.runnerType.ami_experiment.percentage < 1) {
        const random = Math.random();
        if (random < runnerParameters.runnerType.ami_experiment.percentage) {
          console.info(
            `[createRunner]: Joined AMI experiment for ${runnerParameters.runnerType.runnerTypeName} ` +
              `(${random} > ${runnerParameters.runnerType.ami_experiment.percentage}) ` +
              `using AMI: ${runnerParameters.runnerType.ami_experiment.ami}`,
          );
          customAmi = runnerParameters.runnerType.ami_experiment.ami;
          customAmiExperiment = true;
        } else {
          /* istanbul ignore next */
          console.debug(
            `[createRunner]: Skipped AMI experiment for ${runnerParameters.runnerType.runnerTypeName} ` +
              `(${random} > ${runnerParameters.runnerType.ami_experiment.percentage}) `,
          );
        }
      }
    }
    const [launchTemplateName, launchTemplateVersion] = getLaunchTemplateName(runnerParameters);
    const errors: Array<[string, unknown, string]> = [];

    const labelsStrLog = `${
      runnerParameters.runnerType.labels ? ' [' + runnerParameters.runnerType.labels.join(',') + ']' : ''
    }`;

    const shuffledAwsRegionInstances = Config.Instance.shuffledAwsRegionInstances;
    for (const [awsRegionIdx, awsRegion] of shuffledAwsRegionInstances.entries()) {
      const runnerSubnetSequence = await getCreateRunnerSubnetSequence(runnerParameters, awsRegion, metrics);

      const ec2 = new EC2({ region: awsRegion });
      const ssm = new SSM({ region: awsRegion });

      const validSubnets = new Set(
        Config.Instance.awsRegionsToVpcIds
          .get(awsRegion)
          ?.map((vpcId) => Config.Instance.vpcIdToSubnetIds.get(vpcId) ?? [])
          .flat() ?? [],
      );

      const subnets = runnerSubnetSequence.filter((subnet) => validSubnets.has(subnet));
      for (const [subnetIdx, subnet] of subnets.entries()) {
        const vpcId = Config.Instance.subnetIdToVpcId.get(subnet) ?? '!UNDEF!';
        try {
          console.debug(
            `[${awsRegion}] [${vpcId}] [${subnet}] Attempting to create ` +
              `instance ${runnerParameters.runnerType.instance_type}${labelsStrLog}`,
          );
          const runInstancesResponse = await expBackOff(() => {
            return metrics.trackRequestRegion(
              awsRegion,
              metrics.ec2RunInstancesAWSCallSuccess,
              metrics.ec2RunInstancesAWSCallFailure,
              async () => {
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
                      Groups: Config.Instance.vpcIdToSecurityGroupIds.get(vpcId) ?? [],
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
                if (customAmi) {
                  params.ImageId = await findAmiID(metrics, awsRegion, customAmi);
                }
                return await ec2.runInstances(params).promise();
              },
            );
          });

          if (runInstancesResponse.Instances && runInstancesResponse.Instances.length > 0) {
            console.info(
              `Created instance(s) [${awsRegion}] [${vpcId}] [${subnet}]`,
              ` [${runnerParameters.runnerType.runnerTypeName}] [AMI?:${customAmi}] ${labelsStrLog}: `,
              runInstancesResponse.Instances.map((i) => i.InstanceId).join(','),
            );
            addSSMParameterRunnerConfig(
              runInstancesResponse.Instances,
              runnerParameters,
              customAmiExperiment,
              ssm,
              metrics,
              awsRegion,
            );

            // breaks
            return awsRegion;
          } else {
            const msg =
              `[${awsRegion}] [${vpcId}] [${subnet}] [${runnerParameters.runnerType.instance_type}] ` +
              `[${runnerParameters.runnerType.runnerTypeName}]${labelsStrLog} ec2.runInstances returned ` +
              `empty list of instaces created, but exit without throwing any exception (?!?!?!)`;
            errors.push([msg, undefined, awsRegion]);
            console.warn(msg);
          }
        } catch (e) {
          const msg =
            `[${subnetIdx}/${subnets.length} - ${subnet}] ` +
            `[${vpcId}] ` +
            `[${awsRegionIdx}/${shuffledAwsRegionInstances.length} - ${awsRegion}] Issue creating instance ` +
            `${runnerParameters.runnerType.instance_type}${labelsStrLog}: ${e}`;
          errors.push([msg, e, awsRegion]);
          console.warn(msg);
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
        `[${runnerParameters.runnerType.instance_type}]${labelsStrLog} Giving up creating instance, all regions, ` +
          `availability zones and subnets failed. Total exceptions: ${errors.length}; Exceptions count:${excSumm}`,
      );
    } else {
      /* istanbul ignore next */
      throw new Error(
        `[${runnerParameters.runnerType.instance_type}]${labelsStrLog} Failed to runInstances ` +
          `without any exception captured! Check AWS_REGIONS_TO_VPC_IDS, ` +
          `VPC_ID_TO_SECURITY_GROUP_IDS and VPC_ID_TO_SUBNET_IDS environment variables!`,
      );
    }
  } catch (e) {
    /* istanbul ignore next */
    if (e instanceof Error) {
      console.error(`[createRunner]: ${e} - ${e.stack}`);
    } else {
      console.error(`[createRunner]: ${e}`);
    }
    throw e;
  }
}

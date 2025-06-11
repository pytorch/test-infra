import { EC2 } from 'aws-sdk';
import { Metrics } from './metrics';
import { toRunnerInfo } from './runners';
import { RunnerInfo } from './utils';

export async function getRunner(
  metrics: Metrics,
  awsRegion: string,
  instanceId: string,
): Promise<RunnerInfo | undefined> {
  try {
    const result = await metrics.trackRequestRegion(
      awsRegion,
      metrics.ec2DescribeInstancesAWSCallSuccess,
      metrics.ec2DescribeInstancesAWSCallFailure,
      () => {
        return new EC2({ region: awsRegion }).describeInstances({ InstanceIds: [instanceId] }).promise();
      },
    );
    const instance = result.Reservations?.[0]?.Instances?.[0];
    if (!instance) return undefined;

    return toRunnerInfo(instance, awsRegion);
  } catch (e) {
    console.error(`[getEc2Runner]: ${e}`);
    throw e;
  }
}

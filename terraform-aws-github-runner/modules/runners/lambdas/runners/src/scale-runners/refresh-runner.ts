import { ScaleUpMetrics } from "./metrics";
import { getEc2Runner } from "./runners";

export interface ActionRequestMessage {
  id: number;
  instanceId: string;
  awsRegion: string;
}

class RetryableRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableRefreshError';
  }
}

export async function scaleUp(
  eventSource: string,
  payload: ActionRequestMessage,
  metrics: ScaleUpMetrics,
): Promise<void> {
  if (eventSource !== 'aws:sqs') {
    throw Error('Cannot handle non-SQS events!');
  }
  try {
    console.debug(`Start refresh a runner with instance id ${payload.instanceId} in region ${payload.awsRegion}`);
    const runner = await getEc2Runner(metrics, payload.instanceId, payload.awsRegion)
    if (runner === undefined){
        console.warn(`Cannot find runner with instance id ${payload} in region ${payload.awsRegion}`)
        throw new RetryableRefreshError(`Cannot find runner with instance id ${payload} in region ${payload.awsRegion}`)
    }

    } catch (e) {
      /* istanbul ignore next */
      console.error(`Error getting ec2 runner with instance id ${payload} in region ${payload.awsRegion}: ${e}`);
    }


}

import { SQS } from 'aws-sdk';
import { Context, SQSEvent, SQSRecord, ScheduledEvent } from 'aws-lambda';

import { Config } from './scale-runners/config';
import { scaleDown as scaleDownR } from './scale-runners/scale-down';
import { scaleUp as scaleUpR, RetryableScalingError, ActionRequestMessage } from './scale-runners/scale-up';
import { getDelayWithJitter } from './scale-runners/utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function scaleUp(event: SQSEvent, context: Context, callback: any) {
  console.dir(event, { depth: 5 });
  try {
    const evtFailed: Array<SQSRecord> = [];

    for (const evt of event.Records) {
      try {
        await scaleUpR(evt.eventSource, JSON.parse(evt.body));
      } catch (e) {
        if (e instanceof RetryableScalingError) {
          console.error(`Retryable error thrown: "${e.message}"`);
          evtFailed.push(evt);
        } else {
          throw e;
        }
      }
    }

    if (evtFailed.length > 0) {
      console.error(`Detected ${evtFailed.length} errors when processing messages, will retry relevant messages.`);

      const sqs: SQS = new SQS();

      for (const evt of evtFailed) {
        const body: ActionRequestMessage = JSON.parse(evt.body);
        const retryCount = body?.retryCount ?? 0;
        const delaySeconds = Math.max(body?.delaySeconds ?? Config.Instance.retryScaleUpRecordDelayS / 2, 10);

        if (
          retryCount < Config.Instance.maxRetryScaleUpRecord &&
          (Config.Instance.retryScaleUpRecordQueueUrl?.length ?? 0) > 0
        ) {
          body.retryCount = retryCount + 1;
          body.delaySeconds = delaySeconds * 2;

          const sqsPayload: SQS.SendMessageRequest = {
            DelaySeconds: getDelayWithJitter(body.delaySeconds, Config.Instance.retryScaleUpRecordJitterPct),
            MessageBody: JSON.stringify(body),
            QueueUrl: Config.Instance.retryScaleUpRecordQueueUrl as string,
          };

          await sqs.sendMessage(sqsPayload).promise();
        } else {
          console.error(`Permanently abandoning message: ${evt.body}`);
        }
      }
    }

    return callback(null);
  } catch (e) {
    console.error(e);
    return callback('Failed handling SQS event');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function scaleDown(event: ScheduledEvent, context: Context, callback: any) {
  try {
    await scaleDownR();
    return callback(null);
  } catch (e) {
    console.error(e);
    return callback('Failed');
  }
}

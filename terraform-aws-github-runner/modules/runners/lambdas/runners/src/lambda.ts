import { ActionRequestMessage, RetryableScalingError, scaleUp as scaleUpR } from './scale-runners/scale-up';
import { Context, SQSEvent, SQSRecord, ScheduledEvent } from 'aws-lambda';

import { Config } from './scale-runners/config';
import { ScaleUpMetrics, sendMetricsAtTimeout, sendMetricsTimeoutVars } from './scale-runners/metrics';
import { getDelayWithJitterRetryCount, stochaticRunOvershoot } from './scale-runners/utils';
import { scaleDown as scaleDownR } from './scale-runners/scale-down';
import { sqsSendMessages, sqsDeleteMessageBatch } from './scale-runners/sqs';

async function sendRetryEvents(evtFailed: Array<[SQSRecord, boolean, number]>, metrics: ScaleUpMetrics) {
  console.error(`Detected ${evtFailed.length} errors when processing messages, will retry relevant messages.`);
  metrics.exception();
  const messagesToSend: Array<ActionRequestMessage> = [];
  console.dir(evtFailed);

  for (const [evt, retryable, incRetry] of evtFailed) {
    const body: ActionRequestMessage = JSON.parse(evt.body);
    const retryCount = body?.retryCount ?? 0;

    if (
      retryCount < Config.Instance.maxRetryScaleUpRecord &&
      (Config.Instance.retryScaleUpRecordQueueUrl?.length ?? 0) > 0
    ) {
      if (incRetry > 0) {
        if (retryable) {
          metrics.scaleUpFailureRetryable(retryCount);
        } else {
          metrics.scaleUpFailureNonRetryable(retryCount);
        }
      } else {
        metrics.stochasticOvershoot();
      }

      body.retryCount = retryCount + incRetry;
      body.delaySeconds = Math.min(
        900,
        getDelayWithJitterRetryCount(
          retryCount,
          Math.max(Config.Instance.retryScaleUpRecordDelayS, 20),
          Config.Instance.retryScaleUpRecordJitterPct,
        ),
      );
      messagesToSend.push(body);
      console.warn(`Queued message ${body}`);
    } else {
      console.error(`Permanently abandoning message: ${evt.body}`);
    }
  }

  if (messagesToSend.length) {
    sqsSendMessages(metrics, messagesToSend, Config.Instance.retryScaleUpRecordQueueUrl as string);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function scaleUp(event: SQSEvent, context: Context, callback: any) {
  // we mantain open connections to redis, so the event pool is only cleaned when the SIGTERM is sent
  context.callbackWaitsForEmptyEventLoop = false;

  let success = false;
  const metrics = new ScaleUpMetrics();

  const sndMetricsTimout: sendMetricsTimeoutVars = {
    metrics: metrics,
  };
  sndMetricsTimout.setTimeout = setTimeout(
    sendMetricsAtTimeout(sndMetricsTimout),
    (Config.Instance.lambdaTimeout - 10) * 1000,
  );

  const evtFailed: Array<[SQSRecord, boolean, number]> = [];

  try {
    recordsIterProcess: for (let i = 0; i < event.Records.length; i += 1) {
      const evt = event.Records[i];

      try {
        const body = JSON.parse(evt.body) as ActionRequestMessage;
        if (
          !stochaticRunOvershoot(body?.retryCount ?? 0, 900, Math.max(Config.Instance.retryScaleUpRecordDelayS, 20))
        ) {
          console.warn(`Skipping message due to stochatic run overshoot: ${evt.body}`);
          evtFailed.push([evt, true, 0]);
        } else {
          await scaleUpR(evt.eventSource, body, metrics);
          metrics.scaleUpSuccess();
        }
      } catch (e) {
        if (e instanceof RetryableScalingError) {
          console.error(`Retryable error thrown: "${e.message}"`);
          evtFailed.push([evt, true, 1]);
        } else {
          console.error(`Non-retryable error during request: "${e.message}"`);
          console.error(`All remaning '${event.Records.length - i}' messages will be scheduled to retry`);
          for (let ii = i; ii < event.Records.length; ii += 1) {
            evtFailed.push([event.Records[ii], false, 1]);
          }
          break recordsIterProcess;
        }
      }
    }

    if (evtFailed.length > 0) {
      await sendRetryEvents(evtFailed, metrics);
    }

    success = evtFailed.every((i) => {
      return i[1];
    });
  } catch (e) {
    console.error(e);
  } finally {
    if (!success) {
      // In this case the framework does nothing and exits in a dirty state, this makes the message currently being
      // processed to stay in-flight and jam the processing of the other messages due the FIFO nature of the SQS queue
      // so a manual cleanup is required
      if (evtFailed.length > 0) {
        try {
          await sqsDeleteMessageBatch(metrics, event.Records);
          metrics.scaleUpDeleteMessageSuccess(evtFailed.length);
        } catch (e) {
          console.error(`FAILED TO DELETE PROCESSED MESSAGES: ${e}`);
          metrics.scaleUpDeleteMessageFailure(evtFailed.length);
        }
      }
    }

    try {
      clearTimeout(sndMetricsTimout.setTimeout);
      sndMetricsTimout.metrics = undefined;
      sndMetricsTimout.setTimeout = undefined;
      await metrics.sendMetrics();
    } catch (e) {
      console.error(`Error sending metrics: ${e}`);
    }
  }

  if (success) {
    callback(null);
  } else {
    callback('Failed handling SQS event');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function scaleDown(event: ScheduledEvent, context: Context, callback: any) {
  // we mantain open connections to redis, so the event pool is only cleaned when the SIGTERM is sent
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    await scaleDownR();
    return callback(null);
  } catch (e) {
    console.error(e);
    return callback('Failed');
  }
}

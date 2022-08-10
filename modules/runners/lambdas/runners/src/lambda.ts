import { Context, SQSEvent, ScheduledEvent } from 'aws-lambda';

import scaleDownR from './scale-runners/scale-down';
import { scaleUp as scaleUpR } from './scale-runners/scale-up';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function scaleUp(event: SQSEvent, context: Context, callback: any) {
  console.dir(event, { depth: 5 });
  try {
    for (const e of event.Records) {
      await scaleUpR(e.eventSource, JSON.parse(e.body));
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

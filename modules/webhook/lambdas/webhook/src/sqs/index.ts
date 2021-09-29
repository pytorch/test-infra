import { SQS } from 'aws-sdk';
import AWS from 'aws-sdk';

AWS.config.update({
  region: process.env.AWS_REGION,
});

const sqs = new SQS();

export interface ActionRequestMessage {
  id: number;
  eventType: string;
  repositoryName: string;
  repositoryOwner: string;
  installationId: number;
  runnerLabels: string[];
  callbackUrl: string;
}

const NUM_MESSAGE_GROUPS = process.env.NUM_MESSAGE_GROUPS !== undefined ? parseInt(process.env.NUM_MESSAGE_GROUPS) : 1

export const sendActionRequest = async (message: ActionRequestMessage) => {
  const messageGroupId = (Math.floor(Math.random() * NUM_MESSAGE_GROUPS) + 1).toString()
  console.info(`Sending message (Group ${messageGroupId}): ${JSON.stringify(message)}`)
  await sqs
    .sendMessage({
      QueueUrl: String(process.env.SQS_URL_WEBHOOK),
      MessageBody: JSON.stringify(message),
      MessageGroupId: messageGroupId,
    })
    .promise();
};

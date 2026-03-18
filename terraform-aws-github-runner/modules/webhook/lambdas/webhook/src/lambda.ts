import { handle as githubWebhook } from './webhook/handler';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
module.exports.githubWebhook = async (event: any, context: any, callback: any) => {
  console.log('lambda.ts githubWebhook - event:', event);
  try {
    const statusCode = await githubWebhook(event.headers, event.body);
    return callback(null, {
      statusCode: statusCode,
    });
  } catch (error) {
    console.error(`lambda.ts githubWebhook - ${error}`);
    return callback(null, {
      statusCode: 500,
    });
  }
};

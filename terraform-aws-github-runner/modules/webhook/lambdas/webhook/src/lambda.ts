import { handle as githubWebhook } from './webhook/handler';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
module.exports.githubWebhook = async (event: any, context: any, callback: any) => {
  const statusCode = await githubWebhook(event.headers, event.body);
  return callback(null, {
    statusCode: statusCode,
  });
};

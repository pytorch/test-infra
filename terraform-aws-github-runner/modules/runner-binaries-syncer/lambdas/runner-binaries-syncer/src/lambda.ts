import { handle } from './syncer/handler';

// eslint-disable-next-line
module.exports.handler = async (event: any, context: any, callback: any): Promise<any> => {
  await handle();
  return callback();
};

import moment from 'moment';
import nock from 'nock';
import { mocked } from 'ts-jest/utils';
import { Config } from './config';

// Import the required modules
import { getQueuedJobs } from './scale-up-chron';


describe('scaleUp', () => {

  it('getQueuedRunners should fetch queued runners', async () => {
    const runners = await getQueuedJobs();
    console.log('Queued Runners:', runners);
    expect(runners).toBeDefined();
  });
});

// Import the required modules
import { getQueuedJobs } from './scale-up-chron';


test('getQueuedRunners should fetch queued runners', async () => {
  const runners = await getQueuedJobs();
  console.log('Queued Runners:', runners);
  expect(runners).toBeDefined();
});
import { Config } from './config';
import { mocked } from 'ts-jest/utils';
import { getRepo, expBackOff } from './utils';

// import * as ScaleUpChronModule from './scale-up-chron';
import { scaleUpChron, getQueuedJobs } from './scale-up-chron';

import * as MetricsModule from './metrics';

jest.mock('./runners');
jest.mock('./gh-runners');
jest.mock('./gh-issues');
jest.mock('./utils');
jest.mock('axios');

const responseString1 = '[{"runner_label":"test_runner_type1","org":"test_org1","repo":"test_repo1","num_queued_jobs":1,"min_queue_time_minutes":1,"max_queue_time_minutes":1},{"runner_label":"test_runner_type2","org":"test_org2","repo":"test_repo2","num_queued_jobs":2,"min_queue_time_minutes":2,"max_queue_time_minutes":2}]';
const responseString2 = '[{"runner_label":"label1-nomatch","org":"test_org1","repo":"test_repo1","num_queued_jobs":1,"min_queue_time_minutes":1,"max_queue_time_minutes":1},{"runner_label":"test_runner_type2","org":"test_org2","repo":"test_repo2","num_queued_jobs":2,"min_queue_time_minutes":2,"max_queue_time_minutes":2}]';
const responseString3 = '[{"runner_label":"label1","org":"test_org1-nomatch","repo":"test_repo1","num_queued_jobs":1,"min_queue_time_minutes":1,"max_queue_time_minutes":1},{"runner_label":"test_runner_type2","org":"test_org2","repo":"test_repo2","num_queued_jobs":2,"min_queue_time_minutes":2,"max_queue_time_minutes":2}]';

const baseCfg = {
  scaleConfigOrg: 'test_org1',
  scaleUpMinQueueTimeMinutes: 30,
  scaleUpRecordQueueUrl: 'url',
} as unknown as Config;

const metrics = new MetricsModule.ScaleUpChronMetrics();
// beforeEach(() => {
//   jest.resetModules();
//   jest.clearAllMocks();
//   jest.restoreAllMocks();

  // mocked(getRepo).mockReturnValue ({ owner: 'owner', repo: 'repo' });

  // mocked(getRunnerTypes).mockResolvedValue(
  //   new Map([
  //     [
  //       'label1',
  //       {
  //         instance_type: 'instance_type',
  //         os: 'os',
  //         max_available: 33,
  //         disk_size: 113,
  //         runnerTypeName: 'runnerTypeName',
  //         is_ephemeral: false,
  //       },
  //     ],
  //   ]),
  // );
// });
describe('scaleUpChron', () => {

  it('invalid scaleUpRecordQueueUrl', async () => {
    jest.clearAllMocks();
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(
      () =>
        ({
          ...baseCfg,
          scaleUpRecordQueueUrl: null,
        } as unknown as Config),
    );
    mocked(getRepo).mockReturnValue ({ owner: 'owner', repo: 'repo' });
    const scaleUpChron = jest.requireActual('./scale-up-chron').scaleUpChron;
    await expect(scaleUpChron(metrics)).rejects.toThrow(new Error('scaleUpRecordQueueUrl is not set. Cannot send queued scale up requests'));
  });

  it('queued jobs do not match available runners', async () => {
    jest.clearAllMocks();
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
    mocked(getRepo).mockReturnValue ({ owner: 'test_org1', repo: 'test_repo1' });
    mocked(expBackOff).mockResolvedValue({ data: responseString2 });

    const scaleUpInstanceNoOpSpy = jest.spyOn(metrics, 'scaleUpInstanceNoOp');

    await scaleUpChron(metrics)
    expect(scaleUpInstanceNoOpSpy).toBeCalledTimes(1);
  });

  it('queued jobs do not match scale config org', async () => {
    jest.clearAllMocks();
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
    mocked(getRepo).mockReturnValue ({ owner: 'test_org1', repo: 'test_repo1' });
    mocked(expBackOff).mockResolvedValue({ data: responseString3 });

    const scaleUpInstanceNoOp = jest.spyOn(metrics, 'scaleUpInstanceNoOp');
    await scaleUpChron(metrics)
    expect(scaleUpInstanceNoOp).toBeCalledTimes(1);
  });
});

describe('getQueuedJobs', () => {
  it('get queue data from url request with valid response', async () => {
    mocked(expBackOff).mockResolvedValue({ data: responseString1 });

    expect(await getQueuedJobs(metrics, 'url')).toEqual([
      {
        runner_label: 'test_runner_type1',
        org: 'test_org1',
        repo: 'test_repo1',
        num_queued_jobs: 1,
        min_queue_time_minutes: 1,
        max_queue_time_minutes: 1
      }, {
        runner_label: 'test_runner_type2',
        org: 'test_org2',
        repo: 'test_repo2',
        num_queued_jobs: 2,
        min_queue_time_minutes: 2,
        max_queue_time_minutes:2
      }
    ]);
  });

  it('get queue data from url request with invalid response', async () => {
    const errorResponse = '';
    mocked(expBackOff).mockImplementation(
      () => {throw new Error('Throwing a fake error!')});

    const runners = await getQueuedJobs(metrics, 'url');
    expect(await getQueuedJobs(metrics, 'url')).toEqual([]);
  });

  it('get queue data from url request with empty response', async () => {
    const errorResponse = '';
    mocked(expBackOff).mockResolvedValue({ data: errorResponse });

    const runners = await getQueuedJobs(metrics, 'url');
    expect(await getQueuedJobs(metrics, 'url')).toEqual([]);
  });
});

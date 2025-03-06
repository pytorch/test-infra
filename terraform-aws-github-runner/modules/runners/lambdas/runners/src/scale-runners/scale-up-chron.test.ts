import { createRunner } from './runners';
import {
  createRegistrationTokenOrg,
  createRegistrationTokenRepo,
  getGitHubRateLimit,
  getRunnerTypes,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
} from './gh-runners';

import { Config } from './config';
import { getRepoIssuesWithLabel, GhIssues } from './gh-issues';
import { mocked } from 'ts-jest/utils';
import nock from 'nock';
import { scaleUp, _calculateScaleUpAmount } from './scale-up';
import { scaleUpChron, getQueuedJobs } from './scale-up-chron';

import * as MetricsModule from './metrics';

jest.mock('./runners');
jest.mock('./gh-runners');
jest.mock('./gh-issues');


// Import the required modules
import { getQueuedJobs } from './scale-up-chron';

const metrics = new MetricsModule.ScaleUpChronMetrics();

describe('scaleUpChron', () => {
  beforeEach(() => {
    const mockedGetRepo = mocked(getRepo).mockReturnValue('repo');
    const mockedvalidRunnerTypes = mocked(getRunnerTypes).mockResolvedValue(
      new Map([
        [
          'label1',
          {
            instance_type: 'instance_type',
            os: 'os',
            max_available: 33,
            disk_size: 113,
            runnerTypeName: 'runnerTypeName',
            is_ephemeral: false,
          },
        ],
      ]),
    );
  });


  const minAutoScaleupDelayMinutes = Config.Instance.scaleUpMinQueueTimeMinutes;
  if (!Config.Instance.scaleUpRecordQueueUrl) {
    metrics.scaleUpInstanceFailureNonRetryable('scaleUpRecordQueueUrl is not set. Cannot send queued scale up requests');
    throw new Error('scaleUpRecordQueueUrl is not set. Cannot send queued scale up requests');
  }

  it('invalid scaleUpRecordQueueUrl', async () => {
    jest.spyOn(Config, 'Instance', 'get').mockReturnValue(null)
    expect(await scaleUpChron(metrics)).rejects.toThrow('scaleUpRecordQueueUrl is not set. Cannot send queued scale up requests');
  });

  it('queued jobs do not match available runners', async () => {
    jest.spyOn(Config, 'Instance', 'scaleUpMinQueueTimeMinutes').mockReturnValue('url')
    jest.spyOn(Config, 'Instance', 'scaleConfigOrg').mockReturnValue('test_org1')

    const mockedGetQueuedJobs = mocked(getQueuedJobs).mockResolvedValue([
      {
        runner_label: 'label1-nomatch',
        org: 'test_org1',
        repo: 'test_repo1',
        num_queued_jobs: 1,
        min_queue_time_minutes: 1,
        max_queue_time_minutes: 1
      }
    ])
    const scaleUpInstanceNoOp = jest.spyOn(metrics, 'scaleUpInstanceNoOp');
    await scaleUpChron(metrics)
    expect(scaleUpInstanceNoOp).toBeCalledTimes(1);
  });

  it('queued jobs do not match scale config org', async () => {
    jest.spyOn(Config, 'Instance', 'scaleUpMinQueueTimeMinutes').mockReturnValue('url')
    jest.spyOn(Config, 'Instance', 'scaleConfigOrg').mockReturnValue('test_org1')
    const mockedGetQueuedJobs = mocked(getQueuedJobs).mockResolvedValue([
      {
        runner_label: 'label1',
        org: 'test_org1-nomatch',
        repo: 'test_repo1',
        num_queued_jobs: 1,
        min_queue_time_minutes: 1,
        max_queue_time_minutes: 1
      }
    ])
    const scaleUpInstanceNoOp = jest.spyOn(metrics, 'scaleUpInstanceNoOp');
    await scaleUpChron(metrics)
    expect(scaleUpInstanceNoOp).toBeCalledTimes(1);
  });


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

describe('getQueuedJobs', () => {
  it('get queue data from url request with valid response', async () => {
    const dataMap1 = new Map([
      ['runner_type', 'test_runner_type1'],
      ['org', 'test_org1'],
      ['repo', 'test_repo1'],
      ['num_queued_jobs', '1'],
      ['min_queue_time_minutes', '1'],
      ['max_queue_time_minutes', '1']
    ])
    const dataMap2 = new Map([
      ['runner_type', 'test_runner_type2'],
      ['org', 'test_org2'],
      ['repo', 'test_repo2'],
      ['num_queued_jobs', '2'],
      ['min_queue_time_minutes', '2'],
      ['max_queue_time_minutes', '2']
    ])
    jest.spyOn(axios, 'get').mockReturnValue(new Map([['data', [dataMap1, dataMap2]]]));
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
      }
    ]);

  });

  it('get queue data from url request with invalid response', async () => {
    jest.spyOn(axios, 'get').mockReturnValue(new Map([['noDataHere', 'whoops']]));
    const runners = await getQueuedJobs();
    await expect(getQueuedJobs(metrics, 'url')).rejects.toThrow('Error fetching queued runners: {TODO:camyllh test and add error message}');
  });

  it('get queue data from url request with invalid response', async () => {
    jest.spyOn(axios, 'get').mockReturnValue(new Map([['noDataHere', 'whoops']]));
    const runners = await getQueuedJobs();
    await expect(getQueuedJobs(metrics, 'url')).rejects.toThrow('Error fetching queued runners: {TODO:camyllh test and add error message}');
  });

});

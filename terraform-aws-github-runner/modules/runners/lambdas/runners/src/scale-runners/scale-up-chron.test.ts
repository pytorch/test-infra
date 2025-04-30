import { Config } from './config';
import { mocked } from 'ts-jest/utils';
import { getRepo, expBackOff, shuffleArrayInPlace } from './utils';
import { getRunnerTypes } from './gh-runners';

// import * as ScaleUpChronModule from './scale-up-chron';
import { scaleUpChron, getQueuedJobs } from './scale-up-chron';
import { RetryableScalingError, scaleUp } from './scale-up';

import * as MetricsModule from './metrics';
import { RunnerType } from './runners';
import nock from 'nock';
import axios from 'axios';

jest.mock('./runners');
jest.mock('./gh-runners');
jest.mock('./gh-issues');
jest.mock('./utils');
jest.mock('axios');
jest.mock('./scale-up');

const hudQueryValidResponse = [
  {
    runner_label: 'test_runner_type1',
    org: 'test_org1',
    repo: 'test_repo1',
    num_queued_jobs: 1,
    min_queue_time_minutes: 31,
    max_queue_time_minutes: 31,
  },
  {
    runner_label: 'test_runner_type2',
    org: 'test_org2',
    repo: 'test_repo2',
    num_queued_jobs: 2,
    min_queue_time_minutes: 32,
    max_queue_time_minutes: 32,
  },
];
const hudQueryInvalidRunnerLabelResponse = [
  {
    runner_label: 'label1-nomatch',
    org: 'test_org1',
    repo: 'test_repo1',
    num_queued_jobs: 1,
    min_queue_time_minutes: 31,
    max_queue_time_minutes: 31,
  },
  {
    runner_label: 'test_runner_type2',
    org: 'test_org2',
    repo: 'test_repo2',
    num_queued_jobs: 2,
    min_queue_time_minutes: 32,
    max_queue_time_minutes: 32,
  },
];
const hudQueryInvalidOrgResponse = [
  {
    runner_label: 'label1',
    org: 'test_org1-nomatch',
    repo: 'test_repo1',
    num_queued_jobs: 1,
    min_queue_time_minutes: 31,
    max_queue_time_minutes: 31,
  },
  {
    runner_label: 'test_runner_type2',
    org: 'test_org2',
    repo: 'test_repo2',
    num_queued_jobs: 2,
    min_queue_time_minutes: 32,
    max_queue_time_minutes: 32,
  },
];

const runnerTypeValid = 'test_runner_type1';
const runnerTypeInvalid = 'runner_type_invalid';

const baseCfg = {
  scaleConfigOrg: 'test_org1',
  scaleUpMinQueueTimeMinutes: 30,
  scaleUpChronRecordQueueUrl: 'url',
} as unknown as Config;

const metrics = new MetricsModule.ScaleUpChronMetrics();
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();

  nock.disableNetConnect();
});

describe('scaleUpChron', () => {
  it('invalid scaleUpChronRecordQueueUrl', async () => {
    const scaleUpChron = jest.requireActual('./scale-up-chron').scaleUpChron;

    jest.clearAllMocks();
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(
      () =>
        ({
          ...baseCfg,
          scaleUpChronRecordQueueUrl: null,
        } as unknown as Config),
    );

    mocked(getRepo).mockReturnValue({ owner: 'owner', repo: 'repo' });
    mocked(getRunnerTypes).mockResolvedValue(new Map([[runnerTypeValid, { is_ephemeral: false } as RunnerType]]));

    await expect(scaleUpChron(metrics)).rejects.toThrow(
      new Error('scaleUpChronRecordQueueUrl is not set. Cannot send queued scale up requests'),
    );
  });

  it('queued jobs do not match available runners', async () => {
    const scaleUpChronInstanceNoOpSpy = jest.spyOn(metrics, 'scaleUpChronInstanceNoOp');

    jest.clearAllMocks();
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);

    mocked(getRepo).mockReturnValue({ owner: 'test_org1', repo: 'test_repo1' });
    mocked(getRunnerTypes).mockResolvedValue(new Map([[runnerTypeInvalid, { is_ephemeral: false } as RunnerType]]));
    mocked(expBackOff).mockResolvedValue({ data: hudQueryInvalidRunnerLabelResponse });

    await scaleUpChron(metrics);
    expect(scaleUpChronInstanceNoOpSpy).toBeCalledTimes(1);
  });

  it('queued jobs do not match scale config org', async () => {
    const scaleUpChronInstanceNoOp = jest.spyOn(metrics, 'scaleUpChronInstanceNoOp');

    jest.clearAllMocks();
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);

    mocked(getRepo).mockReturnValue({ owner: 'test_org1', repo: 'test_repo1' });
    mocked(expBackOff).mockResolvedValue({ data: hudQueryInvalidOrgResponse });
    mocked(getRunnerTypes).mockResolvedValue(new Map([[runnerTypeInvalid, { is_ephemeral: false } as RunnerType]]));

    await scaleUpChron(metrics);
    expect(scaleUpChronInstanceNoOp).toBeCalledTimes(1);
  });

  it('queued jobs match available runners and scale config org and scaled up completes', async () => {
    const mockedScaleUp = mocked(scaleUp).mockResolvedValue(undefined);
    const scaleUpChronInstanceNoOpSpy = jest.spyOn(metrics, 'scaleUpChronInstanceNoOp');

    jest.clearAllMocks();
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);

    mocked(shuffleArrayInPlace).mockReturnValue([hudQueryValidResponse]);
    mocked(getRepo).mockReturnValue({ owner: 'test_org1', repo: 'test_repo1' });
    mocked(getRunnerTypes).mockResolvedValue(
      new Map([[runnerTypeValid, { runnerTypeName: 'test_runner_type1' } as RunnerType]]),
    );
    mocked(expBackOff).mockResolvedValue({ data: hudQueryValidResponse });

    await scaleUpChron(metrics);
    expect(scaleUpChronInstanceNoOpSpy).toBeCalledTimes(0);
    expect(mockedScaleUp).toBeCalledTimes(1);
  });

  it('scaled up throws error', async () => {
    const mockedScaleUp = mocked(scaleUp).mockRejectedValue(Error('error'));
    const scaleUpChronInstanceFailureNonRetryableSpy = jest.spyOn(metrics, 'scaleUpChronInstanceFailureNonRetryable');

    jest.clearAllMocks();
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);

    mocked(shuffleArrayInPlace).mockReturnValue([hudQueryValidResponse]);
    mocked(getRepo).mockReturnValue({ owner: 'test_org1', repo: 'test_repo1' });
    mocked(getRunnerTypes).mockResolvedValue(
      new Map([[runnerTypeValid, { runnerTypeName: 'test_runner_type1' } as RunnerType]]),
    );
    mocked(expBackOff).mockResolvedValue({ data: hudQueryValidResponse });

    await expect(scaleUpChron(metrics)).rejects.toThrow('Non-retryable errors occurred while scaling up: 1');
    expect(scaleUpChronInstanceFailureNonRetryableSpy).toBeCalledTimes(1);
    expect(mockedScaleUp).toBeCalledTimes(1);
  });

  it('handles RetryableScalingError', async () => {
    // Test for the RetryableScalingError case (lines 82-83)
    const retryableError = new RetryableScalingError('Retryable error');
    const mockedScaleUp = mocked(scaleUp).mockRejectedValue(retryableError);
    const scaleUpChronInstanceFailureRetryableSpy = jest.spyOn(metrics, 'scaleUpChronInstanceFailureRetryable');

    jest.clearAllMocks();
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);

    mocked(shuffleArrayInPlace).mockReturnValue([hudQueryValidResponse]);
    mocked(getRepo).mockReturnValue({ owner: 'test_org1', repo: 'test_repo1' });
    mocked(getRunnerTypes).mockResolvedValue(
      new Map([[runnerTypeValid, { runnerTypeName: 'test_runner_type1' } as RunnerType]]),
    );
    mocked(expBackOff).mockResolvedValue({ data: hudQueryValidResponse });

    // This should not throw since RetryableScalingError is handled differently
    await scaleUpChron(metrics);

    expect(scaleUpChronInstanceFailureRetryableSpy).toBeCalledTimes(1);
    expect(mockedScaleUp).toBeCalledTimes(1);
  });
});

describe('getQueuedJobs', () => {
  it('get queue data from url request with valid response', async () => {
    mocked(expBackOff).mockResolvedValue({ data: hudQueryValidResponse });

    expect(await getQueuedJobs(metrics, 'url')).toEqual([
      {
        runner_label: 'test_runner_type1',
        org: 'test_org1',
        repo: 'test_repo1',
        num_queued_jobs: 1,
        min_queue_time_minutes: 31,
        max_queue_time_minutes: 31,
      },
      {
        runner_label: 'test_runner_type2',
        org: 'test_org2',
        repo: 'test_repo2',
        num_queued_jobs: 2,
        min_queue_time_minutes: 32,
        max_queue_time_minutes: 32,
      },
    ]);
  });

  it('get queue data from url request with invalid response', async () => {
    mocked(expBackOff).mockImplementation(() => {
      throw new Error('Throwing a fake error!');
    });

    expect(await getQueuedJobs(metrics, 'url')).toEqual([]);
  });

  it('get queue data from url request with empty response', async () => {
    const errorResponse = '';
    const hudNoDataspy = jest.spyOn(metrics, 'hudQueuedRunnerFailureNoData');
    const hudFailureSpy = jest.spyOn(metrics, 'hudQueuedRunnerFailure');

    mocked(expBackOff).mockResolvedValue({ data: errorResponse });

    expect(await getQueuedJobs(metrics, 'url')).toEqual([]);
    expect(hudNoDataspy).toBeCalledTimes(1);
    expect(hudFailureSpy).toBeCalledTimes(1);
  });

  it('handles successful response with metrics trackRequest', async () => {
    // Test for lines 121-123
    const trackRequestSpy = jest.spyOn(metrics, 'trackRequest');
    jest.spyOn(metrics, 'getQueuedJobsEndpointSuccess');

    // Create a spy on axios.get
    const axiosGetSpy = jest.spyOn(axios, 'get');

    // Setup the trackRequest to call its callback function
    trackRequestSpy.mockImplementation((success, failure, callback) => {
      return callback();
    });

    // Setup the expBackOff to call its callback function which uses trackRequest
    mocked(expBackOff).mockImplementation((callback) => {
      return callback();
    });

    axiosGetSpy.mockResolvedValue({ data: hudQueryValidResponse });

    await getQueuedJobs(metrics, 'url');

    expect(trackRequestSpy).toHaveBeenCalled();
    expect(axiosGetSpy).toHaveBeenCalledWith('url');
  });

  it('handles invalid data (not an array) from response', async () => {
    // Test for line 142
    const hudQueuedRunnerFailureInvalidDataSpy = jest.spyOn(metrics, 'hudQueuedRunnerFailureInvalidData');

    mocked(expBackOff).mockResolvedValue({ data: { notAnArray: true } });

    try {
      await getQueuedJobs(metrics, 'url');
    } catch (error) {
      // The function will throw an error, but we want to verify the metric was called
    }

    expect(hudQueuedRunnerFailureInvalidDataSpy).toHaveBeenCalled();
  });
});

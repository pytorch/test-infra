import { Config } from './config';
import * as MetricsModule from './metrics';
import { mocked } from 'ts-jest/utils';
import nock from 'nock';
import { Repo, RunnerInfo, RunnerValueError, sleep } from './utils';
import { RunnerInputParameters, RunnerType, tryRefreshRunner } from './runners';
import { getRunner } from './runner-utils';
import { ephPostJob, RetryableEphPostJobError } from './eph-post-job';
import { createRegistrationTokenRepo, getRunnerTypes } from './gh-runners';
import { expectToThrow, FakeRunnerTypes, getFakeRunnerInfoRepo, getFakeRunnerType, TEST_RUNNER_TYPE_1, TEST_RUNNER_TYPE_1_NAME } from './test-utils';
import { get } from 'http';
import { locallyCached } from './cache';

jest.mock('./gh-runners');
jest.mock('./runners');
jest.mock('./runner-utils');
jest.mock('./utils', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  ...(jest.requireActual('./utils') as any),
  sleep: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./cache', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  ...(jest.requireActual('./cache') as any),
  redisClearCacheKeyPattern: jest.fn(),
  redisLocked: jest.fn().mockImplementation(async <T>(ns: string, k: string, cb: () => Promise<T>): Promise<T> => {
    return await cb();
  }),
  redisCached: jest
    .fn()
    .mockImplementation(async <T>(ns: string, k: string, t: number, j: number, fn: () => Promise<T>): Promise<T> => {
      return await locallyCached(ns, k, t, fn);
    }),
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  getJoinedStressTestExperiment: jest.fn().mockImplementation(async (experimentKey: string, defaultValue: string) => {
    return false;
  }),
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();
});

function getDefaultPayload(){
    return {
        id: 10,
        instanceId: 'i-123',
        awsRegion: 'us-east-1',
      };
}

const baseCfg = {
  awsRegion: 'us-east-1',
  cantHaveIssuesLabels: [],
  mustHaveIssuesLabels: [],
  lambdaTimeout: 600,

} as unknown as Config;

const metrics = new MetricsModule.ScaleUpMetrics();
const fakeRunnerTypes = new FakeRunnerTypes();
let mockedGetRunnerTypes: jest.Mock;
let mockedGetRunner: jest.Mock;
let mockedTryRefreshRunner: jest.Mock;

describe('ephPostJob', () => {
  beforeEach(() => {
    jest.spyOn(MetricsModule, 'ScaleUpMetrics').mockReturnValue(metrics);
    jest.spyOn(metrics, 'sendMetrics').mockImplementation(async () => {
      return;
    });

    fakeRunnerTypes.reset(); // Reset to default before each test
    mockedGetRunner = mocked(getRunner).mockResolvedValue(getFakeRunnerInfoRepo());
    mockedTryRefreshRunner = mocked(tryRefreshRunner).mockResolvedValue(undefined);
    mockedGetRunnerTypes = mocked(getRunnerTypes).mockResolvedValue(fakeRunnerTypes.get());
  });

    it('don`t have sufficient runners, max_available is undefined', async (): Promise<void> => {
      const config = {
        ...baseCfg,
        environment: 'config.environ',
        ghesUrlHost: 'https://github.com',
        minAvailableRunners: 10,
        runnersExtraLabels: 'extra-label',
      };
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
      const payload = getDefaultPayload();
      const token = 'AGDGADUWG113'
      const repo: Repo = {
        repo: 'example-repo',
        owner: 'example-org',
      }

      const mockedCreateRegistrationTokenForRepo = mocked(createRegistrationTokenRepo).mockResolvedValue(token);
      const mockedTryRefreshRunner = mocked(tryRefreshRunner);

      await ephPostJob('aws:sqs', payload, expect.anything());
      await ephPostJob('aws:sqs', payload, expect.anything());
      expect(mockedTryRefreshRunner).toBeCalledWith(
        {
          environment: config.environment,
          repoName: "example-org/example-repo",
          runnerConfig: expect.any(Function),
          runnerType: getFakeRunnerType(),
          repositoryName: repo.repo,
          repositoryOwner: repo.owner,
        },
        expect.anything(),
        getFakeRunnerInfoRepo()
      );

      expect(await mockedTryRefreshRunner.mock.calls[0][0].runnerConfig(config.awsRegion, true)).toEqual(
        `--url ${config.ghesUrlHost}/example-org/example-repo --token ${token} --labels AWS:${config.awsRegion},${TEST_RUNNER_TYPE_1},` +
          `experimental.ami,extra-label --ephemeral`,
      );
      expect(mockedCreateRegistrationTokenForRepo).toBeCalledWith(repo, expect.anything(), undefined);
    });

    it("provides runnerLabels that aren't present in runnerTypes", async () => {
        jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
        const payload = getDefaultPayload();

        await ephPostJob('aws:sqs', payload, expect.anything());

        expect(mockedGetRunnerTypes).toHaveBeenCalledTimes(1);
        expect(mockedGetRunnerTypes).toHaveBeenCalledWith(
          { repo: 'example-repo', owner: 'example-org' },
          expect.anything(),
          expect.anything()
        );
      });

  it('does not accept sources that are not aws:sqs', async () => {
    const payload = {
      id: 10,
      instanceId: 'i-1234567890',
      awsRegion: 'us-east-1',
    };
    await expect(ephPostJob('other', payload, metrics)).rejects.toThrow('Cannot handle non-SQS events!');
  });

  it('refresh a instance successfully', async () => {
    const config = {
      ...baseCfg,
      environment: 'test-config-env',
      ghesUrlHost: 'https://github.com',
    };
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);

    const payload = {
      id: 10,
      awsRegion: 'us-east-1',
      instanceId: 'test-id',
    };

    await ephPostJob('aws:sqs', payload, metrics);

    const params: RunnerInputParameters = {
      runnerConfig: expect.any(Function),
      environment: 'test-config-env',
      runnerType: {
        disk_size: 0,
        instance_type: 'instance-type-1',
        is_ephemeral: true,
        os: 'test-os',
        runnerTypeName: TEST_RUNNER_TYPE_1,
      },
      repositoryOwner: 'example-org',
      repositoryName: 'example-repo',
    };
    expect(mockedGetRunner).toHaveBeenCalledTimes(1);
    expect(mockedTryRefreshRunner).toHaveBeenCalledTimes(1);
    const [calledParams] = mockedTryRefreshRunner.mock.calls[0];
    expect(calledParams).toMatchObject(params);
  });

  it('throws RetryableEphPostJobError if runner is not found', async () => {
    const payload = {
      id: 10,
      instanceId: 'i-123',
      awsRegion: 'us-east-1',
    };

    mocked(getRunner).mockResolvedValueOnce(undefined);
    await expectToThrow(() => ephPostJob('aws:sqs', payload, metrics), RetryableEphPostJobError, 'Runner is undefined');
  });

  it(`throws RunnerValueError if both repo and org are missing`, async () => {
    // prepare
    const runner = getFakeRunnerInfoRepo();
    runner.org = undefined;
    runner.repo = undefined;
    mocked(getRunner).mockResolvedValueOnce(runner);
    const payload = getDefaultPayload();

    // execute
    await expectToThrow(() => ephPostJob('aws:sqs', payload, metrics),RunnerValueError, /repo\/org/);

    expect(mockedGetRunner).toHaveBeenCalledTimes(1);
    expect(mockedTryRefreshRunner).not.toHaveBeenCalled();
  });

  describe('runner info missing required items from runner', () => {
    beforeEach(() => {
      jest.spyOn(MetricsModule, 'ScaleUpMetrics').mockReturnValue(metrics);
      jest.spyOn(metrics, 'sendMetrics').mockImplementation(async () => {
        return;
      });

      fakeRunnerTypes.reset(); // Reset to default before each test
      mockedGetRunner = mocked(getRunner).mockResolvedValue(getFakeRunnerInfoRepo());
      mockedTryRefreshRunner = mocked(tryRefreshRunner).mockResolvedValue(undefined);
      mockedGetRunnerTypes = mocked(getRunnerTypes).mockResolvedValue(fakeRunnerTypes.get());
    });

    const payload = getDefaultPayload();

    const requiredFields = ['runnerType', 'repositoryOwner', 'repositoryName'] as const;
    for (const field of requiredFields) {
        it(`throws ValueError if required runner metadata is missing: ${field}`, async () => {
          const runner = getFakeRunnerInfoRepo();
          delete (runner as any)[field];
          mocked(getRunner).mockResolvedValueOnce(runner);

          await expect(ephPostJob('aws:sqs', payload, metrics)).rejects.toThrowError(RunnerValueError);
          expect(mockedTryRefreshRunner).not.toHaveBeenCalled();
        });
      }
  });
});
function getDefautltFakeRunnerTypes(): any {
    throw new Error('Function not implemented.');
}

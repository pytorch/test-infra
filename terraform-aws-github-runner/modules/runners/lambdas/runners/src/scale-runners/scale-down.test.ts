import moment from 'moment';
import nock from 'nock';
import { mocked } from 'ts-jest/utils';
import { Config } from './config';
import { resetSecretCache } from './gh-auth';
import { RunnerInfo, Repo } from './utils';
import {
  getRunnerOrg,
  getRunnerRepo,
  getRunnerTypes,
  GhRunner,
  GhRunners,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
  removeGithubRunnerOrg,
  removeGithubRunnerRepo,
  resetGHRunnersCaches,
} from './gh-runners';
import * as MetricsModule from './metrics';
import {
  doDeleteSSMParameter,
  listRunners,
  resetRunnersCaches,
  terminateRunner,
  RunnerType,
  listSSMParameters,
} from './runners';
import {
  cleanupOldSSMParameters,
  getGHRunnerOrg,
  getGHRunnerRepo,
  isEphemeralRunner,
  isRunnerRemovable,
  minRunners,
  runnerMinimumTimeExceeded,
  scaleDown,
  sortRunnersByLaunchTime,
  sortSSMParametersByUpdateTime,
} from './scale-down';
import { RequestError } from '@octokit/request-error';
import { SSM } from 'aws-sdk';

jest.mock('./gh-runners', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  ...(jest.requireActual('./gh-runners') as any),
  getRunnerOrg: jest.fn(),
  getRunnerRepo: jest.fn(),
  getRunnerTypes: jest.fn(),
  listGithubRunnersOrg: jest.fn(),
  listGithubRunnersRepo: jest.fn(),
  removeGithubRunnerOrg: jest.fn(),
  removeGithubRunnerRepo: jest.fn(),
  resetGHRunnersCaches: jest.fn(),
}));

jest.mock('./runners', () => ({
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  ...(jest.requireActual('./runners') as any),
  doDeleteSSMParameter: jest.fn(),
  listRunners: jest.fn(),
  listSSMParameters: jest.fn(),
  resetRunnersCaches: jest.fn(),
  terminateRunner: jest.fn(),
}));

jest.mock('./gh-auth', () => ({
  resetSecretCache: jest.fn(),
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();
});

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const mockRunner = (runnerDef: any) => {
  return runnerDef as GhRunner;
};

const MAX_SSM_PARAMETERS = 25;

const metrics = new MetricsModule.ScaleDownMetrics();

const minimumRunningTimeInMinutes = 10;
const environment = 'environment';
const subnetIds = new Map([['us-east-1', new Set(['sub-0987', 'sub-7890'])]]);
const baseConfig = {
  minimumRunningTimeInMinutes: minimumRunningTimeInMinutes,
  environment: environment,
  minAvailableRunners: 0,
  awsRegion: 'us-east-1',
  shuffledAwsRegionInstances: ['us-east-1'],
  shuffledSubnetIdsForAwsRegion: jest.fn().mockImplementation((awsRegion: string) => {
    return Array.from(subnetIds.get(awsRegion) ?? []).sort();
  }),
  sSMParamCleanupAgeDays: 7,
  sSMParamMaxCleanupAllowance: MAX_SSM_PARAMETERS, // Easier to test
};

describe('scale-down', () => {
  beforeEach(() => {
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseConfig as unknown as Config);
    jest.spyOn(MetricsModule, 'ScaleDownMetrics').mockReturnValue(metrics);
    jest.spyOn(metrics, 'sendMetrics').mockImplementation(async () => {
      return;
    });
  });

  describe('scaleDown', () => {
    it('no runners are found', async () => {
      const ec2runner = {
        instanceId: 'WG113',
        repo: 'owner/repo',
        launchTime: moment(new Date())
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
        ghRunnerId: '33',
      };
      const matchRunner: GhRunners = [
        {
          id: 1,
          name: ec2runner.instanceId,
          os: 'linux',
          status: 'busy',
          busy: true,
          labels: [],
        },
      ];
      const mockedListRunners = mocked(listRunners).mockResolvedValue([]);
      mocked(listGithubRunnersRepo).mockResolvedValue(matchRunner);

      await scaleDown();

      expect(mockedListRunners).toBeCalledWith(metrics, { environment: environment });
    });

    it('ec2runner with repo = undefined && org = undefined', async () => {
      mocked(listRunners).mockResolvedValue([
        {
          awsRegion: Config.Instance.awsRegion,
          instanceId: 'WG113',
          launchTime: moment(new Date())
            .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
            .toDate(),
        },
      ]);
      const mockedResetRunnersCaches = mocked(resetRunnersCaches);
      const mockedResetGHRunnersCaches = mocked(resetGHRunnersCaches);
      const mockedResetSecretCache = mocked(resetSecretCache);
      const mockedListGithubRunners = mocked(listGithubRunnersRepo);
      const mockedListGithubRunnersOrg = mocked(listGithubRunnersOrg);
      const mockedRemoveGithubRunnerOrg = mocked(removeGithubRunnerOrg);
      const mockedRemoveGithubRunnerRepo = mocked(removeGithubRunnerRepo);
      const mockedTerminateRunner = mocked(terminateRunner);

      await scaleDown();

      expect(mockedResetRunnersCaches).toBeCalledTimes(1);
      expect(mockedResetGHRunnersCaches).toBeCalledTimes(1);
      expect(mockedResetSecretCache).toBeCalledTimes(1);
      expect(mockedListGithubRunners).not.toBeCalled();
      expect(mockedListGithubRunnersOrg).not.toBeCalled();
      expect(mockedRemoveGithubRunnerOrg).not.toBeCalled();
      expect(mockedRemoveGithubRunnerRepo).not.toBeCalled();
      expect(mockedTerminateRunner).not.toBeCalled();
    });
  });

  describe('org', () => {
    const environment = 'environment';
    const scaleConfigRepo = 'test-infra';
    const theOrg = ' a-owner';
    const dateRef = moment(new Date());
    const runnerTypes = new Map([
      ['ignore-no-org-no-repo', { is_ephemeral: false } as RunnerType],
      ['ignore-no-org', { is_ephemeral: false } as RunnerType],
      ['keep-all-4', { is_ephemeral: false } as RunnerType],
      ['a-ephemeral-runner', { is_ephemeral: true } as RunnerType],
      ['keep-min-runners-oldest', { is_ephemeral: false } as RunnerType],
      ['keep-lt-min-no-ghrunner', { is_ephemeral: false } as RunnerType],
    ]);
    const ghRunners = [
      mockRunner({ id: '0001', name: 'keep-this-not-min-time-01', busy: false, status: 'online' }),
      mockRunner({ id: '0002', name: 'keep-this-not-min-time-02', busy: false, status: 'online' }),
      mockRunner({ id: '0003', name: 'keep-this-is-busy-01', busy: true, status: 'online' }),
      mockRunner({ id: '0004', name: 'keep-this-is-busy-02', busy: true, status: 'online' }),
      mockRunner({ id: '0005', name: 'keep-this-not-min-time-03', busy: false, status: 'online' }),
      mockRunner({ id: '0006', name: 'keep-this-is-busy-03', busy: true, status: 'online' }),
      mockRunner({ id: '0007', name: 'keep-ephemeral-01-fail-ghr', busy: false, status: 'online' }),
      mockRunner({ id: '0008', name: 'keep-min-runners-not-oldest-01', busy: false, status: 'online' }),
      mockRunner({ id: '0009', name: 'keep-min-runners-oldest-01', busy: false, status: 'online' }),
      mockRunner({ id: '0010', name: 'keep-min-runners-not-oldest-02', busy: false, status: 'online' }),
      mockRunner({ id: '0011', name: 'keep-min-runners-oldest-02', busy: false, status: 'online' }),
      mockRunner({ id: '0012', name: 'keep-lt-min-no-ghrunner-01', busy: false, status: 'online' }),
      mockRunner({ id: '0013', name: 'remove-offline-01', busy: false, status: 'offline' }),
      mockRunner({ id: '0014', name: 'remove-offline-02', busy: false, status: 'offline' }),
    ] as GhRunners;
    const listRunnersRet = [
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'ignore-no-org-no-repo',
        instanceId: '001',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'ignore-no-org-no-repo',
        instanceId: '002',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 3, 'minutes')
          .toDate(),
      },

      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'ignore-no-org',
        instanceId: '003',
        repo: 'a-owner/a-repo',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 3, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'ignore-no-org',
        instanceId: '004',
        repo: 'a-owner/a-repo',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 3, 'minutes')
          .toDate(),
      },

      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-not-min-time-01',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-not-min-time-02',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 3, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-is-busy-01',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-is-busy-02',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },

      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-this-not-min-time-03',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-this-is-busy-03',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-ephemeral-01-fail-ghr', // X
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'a-ephemeral-runner',
        instanceId: 'remove-ephemeral-02', // X
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-this-ebs-not-min-time-01',
        org: theOrg,
        ebsVolumeReplacementRequestTimestamp: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 2, 'minutes')
          .unix(),
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-this-recently-finished-job-01',
        org: theOrg,
        ephemeralRunnerFinished: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 2, 'minutes')
          .unix(),
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-not-oldest-01',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-oldest-01', // X
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 7, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-not-oldest-02',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 6, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-oldest-02', // X
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 8, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-lt-min-no-ghrunner',
        instanceId: 'keep-lt-min-no-ghrunner-no-ghr-01', // X
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-lt-min-no-ghrunner',
        instanceId: 'keep-lt-min-no-ghrunner-no-ghr-02', // X
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 7, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-lt-min-no-ghrunner',
        instanceId: 'keep-lt-min-no-ghrunner-01',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 6, 'minutes')
          .toDate(),
      },
    ];
    const getRunnerPair = (instanceId: string) => {
      return {
        awsR: listRunnersRet.find((itm) => {
          return itm.instanceId === instanceId;
        }) as RunnerInfo,
        ghR: ghRunners.find((itm) => {
          return itm.name === instanceId;
        }) as GhRunner,
      };
    };

    beforeEach(() => {
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(
        () =>
          ({
            ...baseConfig,
            enableOrganizationRunners: true,
            scaleConfigRepo: scaleConfigRepo,
            minAvailableRunners: 2,
            environment: environment,
          } as unknown as Config),
      );
    });

    it('do according each one', async () => {
      const mockedListRunners = mocked(listRunners);
      const mockedListGithubRunnersOrg = mocked(listGithubRunnersOrg);
      const mockedGetRunnerTypes = mocked(getRunnerTypes);
      const mockedRemoveGithubRunnerOrg = mocked(removeGithubRunnerOrg);
      const mockedTerminateRunner = mocked(terminateRunner);

      mockedListRunners.mockResolvedValueOnce(listRunnersRet);
      mockedListGithubRunnersOrg.mockResolvedValue(ghRunners);
      mockedGetRunnerTypes.mockResolvedValue(runnerTypes);
      mockedRemoveGithubRunnerOrg.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        async (runnerId: number, org: string, metrics: MetricsModule.Metrics) => {
          if (runnerId == 7) {
            throw 'Failure';
          }
        },
      );

      await scaleDown();

      expect(mockedListRunners).toBeCalledTimes(1);
      expect(mockedListRunners).toBeCalledWith(metrics, { environment: environment });

      expect(mockedListGithubRunnersOrg).toBeCalledTimes(18);
      expect(mockedListGithubRunnersOrg).toBeCalledWith(theOrg, metrics);

      expect(mockedGetRunnerTypes).toBeCalledTimes(9);
      expect(mockedGetRunnerTypes).toBeCalledWith({ owner: theOrg, repo: scaleConfigRepo }, metrics);

      expect(mockedRemoveGithubRunnerOrg).toBeCalledTimes(4);
      {
        const { awsR, ghR } = getRunnerPair('keep-min-runners-oldest-02');
        expect(mockedRemoveGithubRunnerOrg).toBeCalledWith(ghR.id, awsR.org as string, metrics);
      }
      {
        const { awsR, ghR } = getRunnerPair('keep-min-runners-oldest-01');
        expect(mockedRemoveGithubRunnerOrg).toBeCalledWith(ghR.id, awsR.org as string, metrics);
      }
      {
        const { ghR } = getRunnerPair('remove-offline-01');
        expect(mockedRemoveGithubRunnerOrg).toBeCalledWith(ghR.id, theOrg, metrics);
      }
      {
        const { ghR } = getRunnerPair('remove-offline-02');
        expect(mockedRemoveGithubRunnerOrg).toBeCalledWith(ghR.id, theOrg, metrics);
      }

      expect(mockedTerminateRunner).toBeCalledTimes(5);
      {
        const { awsR } = getRunnerPair('keep-lt-min-no-ghrunner-no-ghr-02');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        const { awsR } = getRunnerPair('keep-lt-min-no-ghrunner-no-ghr-01');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        const { awsR } = getRunnerPair('keep-min-runners-oldest-02');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        const { awsR } = getRunnerPair('keep-min-runners-oldest-01');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        const { awsR } = getRunnerPair('remove-ephemeral-02');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
    });
  });

  describe('repo', () => {
    const environment = 'environment';
    const theRepo = 'a-owner/a-repo';
    const repo = { owner: 'a-owner', repo: 'a-repo' };
    const dateRef = moment(new Date());
    const runnerTypes = new Map([
      ['ignore-no-org-no-repo', { is_ephemeral: false } as RunnerType],
      ['ignore-no-repo', { is_ephemeral: false } as RunnerType],
      ['keep-all-4', { is_ephemeral: false } as RunnerType],
      ['a-ephemeral-runner', { is_ephemeral: true } as RunnerType],
      ['keep-min-runners-oldest', { is_ephemeral: false } as RunnerType],
      ['keep-lt-min-no-ghrunner', { is_ephemeral: false } as RunnerType],
    ]);
    const ghRunners = [
      mockRunner({ id: '0001', name: 'keep-this-not-min-time-01', busy: false, status: 'online' }),
      mockRunner({ id: '0002', name: 'keep-this-not-min-time-02', busy: false, status: 'online' }),
      mockRunner({ id: '0003', name: 'keep-this-is-busy-01', busy: true, status: 'online' }),
      mockRunner({ id: '0004', name: 'keep-this-is-busy-02', busy: true, status: 'online' }),
      mockRunner({ id: '0005', name: 'keep-this-not-min-time-03', busy: false, status: 'online' }),
      mockRunner({ id: '0006', name: 'keep-this-is-busy-03', busy: true, status: 'online' }),
      mockRunner({ id: '0007', name: 'keep-ephemeral-01-fail-ghr', busy: false, status: 'online' }),
      mockRunner({ id: '0008', name: 'keep-min-runners-not-oldest-01', busy: false, status: 'online' }),
      mockRunner({ id: '0009', name: 'keep-min-runners-oldest-01', busy: false, status: 'online' }),
      mockRunner({ id: '0010', name: 'keep-min-runners-not-oldest-02', busy: false, status: 'online' }),
      mockRunner({ id: '0011', name: 'keep-min-runners-oldest-02', busy: false, status: 'online' }),
      mockRunner({ id: '0012', name: 'keep-lt-min-no-ghrunner-01', busy: false, status: 'online' }),
      mockRunner({ id: '0013', name: 'remove-offline-01', busy: false, status: 'offline' }),
      mockRunner({ id: '0014', name: 'remove-offline-02', busy: false, status: 'offline' }),
    ] as GhRunners;
    const listRunnersRet = [
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'ignore-no-org-no-repo',
        instanceId: '001',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'ignore-no-org-no-repo',
        instanceId: '002',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 3, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'ignore-no-repo',
        instanceId: '003',
        org: 'a-owner',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 3, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'ignore-no-repo',
        instanceId: '004',
        org: 'a-owner',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 3, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-not-min-time-01',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-not-min-time-02',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 3, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-is-busy-01',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-is-busy-02',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-this-not-min-time-03',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-this-is-busy-03',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-ephemeral-01-fail-ghr', // X
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'a-ephemeral-runner',
        instanceId: 'remove-ephemeral-02', // X
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-this-ebs-not-min-time-01',
        repo: theRepo,
        ebsVolumeReplacementRequestTimestamp: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 2, 'minutes')
          .unix(),
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-this-recently-finished-job-01',
        repo: theRepo,
        ephemeralRunnerFinished: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 2, 'minutes')
          .unix(),
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-not-oldest-01',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-oldest-01', // X
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 7, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-not-oldest-02',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 6, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-oldest-02', // X
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 8, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-lt-min-no-ghrunner',
        instanceId: 'keep-lt-min-no-ghrunner-no-ghr-01', // X
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-lt-min-no-ghrunner',
        instanceId: 'keep-lt-min-no-ghrunner-no-ghr-02', // X
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 7, 'minutes')
          .toDate(),
      },
      {
        awsRegion: baseConfig.awsRegion,
        runnerType: 'keep-lt-min-no-ghrunner',
        instanceId: 'keep-lt-min-no-ghrunner-01',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 6, 'minutes')
          .toDate(),
      },
    ];
    const getRunnerPair = (instanceId: string) => {
      return {
        awsR: listRunnersRet.find((itm) => {
          return itm.instanceId === instanceId;
        }) as RunnerInfo,
        ghR: ghRunners.find((itm) => {
          return itm.name === instanceId;
        }) as GhRunner,
      };
    };

    beforeEach(() => {
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(
        () =>
          ({
            ...baseConfig,
            enableOrganizationRunners: false,
            minAvailableRunners: 2,
            environment: environment,
          } as unknown as Config),
      );
    });

    it('do according each one', async () => {
      const mockedListRunners = mocked(listRunners);
      const mockedListGithubRunnersRepo = mocked(listGithubRunnersRepo);
      const mockedGetRunnerTypes = mocked(getRunnerTypes);
      const mockedRemoveGithubRunnerRepo = mocked(removeGithubRunnerRepo);
      const mockedTerminateRunner = mocked(terminateRunner);

      mockedListRunners.mockResolvedValueOnce(listRunnersRet);
      mockedListGithubRunnersRepo.mockResolvedValue(ghRunners);
      mockedGetRunnerTypes.mockResolvedValue(runnerTypes);
      mockedRemoveGithubRunnerRepo.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        async (runnerId: number, repo: Repo, metrics: MetricsModule.Metrics) => {
          if (runnerId == 7) {
            throw 'Failure';
          }
        },
      );

      await scaleDown();

      expect(mockedListRunners).toBeCalledTimes(1);
      expect(mockedListRunners).toBeCalledWith(metrics, { environment: environment });

      expect(mockedListGithubRunnersRepo).toBeCalledTimes(18);
      expect(mockedListGithubRunnersRepo).toBeCalledWith(repo, metrics);

      expect(mockedGetRunnerTypes).toBeCalledTimes(9);
      expect(mockedGetRunnerTypes).toBeCalledWith(repo, metrics);

      expect(mockedRemoveGithubRunnerRepo).toBeCalledTimes(4);
      {
        const { ghR } = getRunnerPair('keep-min-runners-oldest-02');
        expect(mockedRemoveGithubRunnerRepo).toBeCalledWith(ghR.id, repo, metrics);
      }
      {
        const { ghR } = getRunnerPair('keep-min-runners-oldest-01');
        expect(mockedRemoveGithubRunnerRepo).toBeCalledWith(ghR.id, repo, metrics);
      }
      {
        const { ghR } = getRunnerPair('remove-offline-01');
        expect(mockedRemoveGithubRunnerRepo).toBeCalledWith(ghR.id, repo, metrics);
      }
      {
        const { ghR } = getRunnerPair('remove-offline-02');
        expect(mockedRemoveGithubRunnerRepo).toBeCalledWith(ghR.id, repo, metrics);
      }

      expect(mockedTerminateRunner).toBeCalledTimes(5);
      {
        const { awsR } = getRunnerPair('keep-lt-min-no-ghrunner-no-ghr-02');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        const { awsR } = getRunnerPair('keep-lt-min-no-ghrunner-no-ghr-01');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        const { awsR } = getRunnerPair('keep-min-runners-oldest-02');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        const { awsR } = getRunnerPair('keep-min-runners-oldest-01');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        const { awsR } = getRunnerPair('remove-ephemeral-02');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
    });
  });

  describe('sortRunnersByLaunchTime', () => {
    it('two undefined', async () => {
      const ret = sortRunnersByLaunchTime([
        {
          awsRegion: baseConfig.awsRegion,
          instanceId: 'WG113',
          repo: undefined,
          launchTime: undefined,
        },
        {
          awsRegion: baseConfig.awsRegion,
          instanceId: 'WG113',
          repo: undefined,
          launchTime: undefined,
        },
      ]);

      expect(ret[0].launchTime).toBeUndefined();
      expect(ret[1].launchTime).toBeUndefined();
    });

    it('undefined valid', async () => {
      const dt = moment(new Date()).toDate();
      const ret = sortRunnersByLaunchTime([
        {
          awsRegion: baseConfig.awsRegion,
          instanceId: 'WG113',
          repo: undefined,
          launchTime: undefined,
        },
        {
          awsRegion: baseConfig.awsRegion,
          instanceId: 'WG113',
          repo: undefined,
          launchTime: dt,
        },
      ]);

      expect(ret[0].launchTime).toEqual(dt);
      expect(ret[1].launchTime).toBeUndefined();
    });

    it('valid undefined', async () => {
      const dt = moment(new Date()).toDate();
      const ret = sortRunnersByLaunchTime([
        {
          awsRegion: baseConfig.awsRegion,
          instanceId: 'WG113',
          repo: undefined,
          launchTime: dt,
        },
        {
          awsRegion: baseConfig.awsRegion,
          instanceId: 'WG113',
          repo: undefined,
          launchTime: undefined,
        },
      ]);

      expect(ret[0].launchTime).toEqual(dt);
      expect(ret[1].launchTime).toBeUndefined();
    });

    it('bigger smaller', async () => {
      const dt1 = moment(new Date()).add(50, 'seconds').toDate();
      const dt2 = moment(new Date()).subtract(50, 'seconds').toDate();
      const ret = sortRunnersByLaunchTime([
        {
          awsRegion: baseConfig.awsRegion,
          instanceId: 'WG113',
          repo: undefined,
          launchTime: dt1,
        },
        {
          awsRegion: baseConfig.awsRegion,
          instanceId: 'WG113',
          repo: undefined,
          launchTime: dt2,
        },
      ]);

      expect(ret[0].launchTime).toEqual(dt2);
      expect(ret[1].launchTime).toEqual(dt1);
    });

    it('smaller bigger', async () => {
      const dt1 = moment(new Date()).add(50, 'seconds').toDate();
      const dt2 = moment(new Date()).subtract(50, 'seconds').toDate();
      const ret = sortRunnersByLaunchTime([
        {
          awsRegion: baseConfig.awsRegion,
          instanceId: 'WG113',
          repo: undefined,
          launchTime: dt2,
        },
        {
          awsRegion: baseConfig.awsRegion,
          instanceId: 'WG113',
          repo: undefined,
          launchTime: dt1,
        },
      ]);

      expect(ret[0].launchTime).toEqual(dt2);
      expect(ret[1].launchTime).toEqual(dt1);
    });

    it('equal', async () => {
      const launchTime = moment(new Date()).subtract(50, 'seconds').toDate();
      const ret = sortRunnersByLaunchTime([
        {
          awsRegion: baseConfig.awsRegion,
          instanceId: 'WG113',
          repo: undefined,
          launchTime: launchTime,
        },
        {
          awsRegion: baseConfig.awsRegion,
          instanceId: 'WG113',
          repo: undefined,
          launchTime: launchTime,
        },
      ]);

      expect(ret[0].launchTime).toEqual(launchTime);
      expect(ret[1].launchTime).toEqual(launchTime);
    });
  });

  describe('sortSSMParametersByUpdateTime', () => {
    it('two undefined', async () => {
      const ret = sortSSMParametersByUpdateTime([
        {
          Name: 'WG113',
          LastModifiedDate: undefined,
        },
        {
          Name: 'WG114',
          LastModifiedDate: undefined,
        },
      ]);

      expect(ret[0].LastModifiedDate).toBeUndefined();
      expect(ret[1].LastModifiedDate).toBeUndefined();
    });

    it('undefined valid', async () => {
      const dt = moment(new Date()).toDate();
      const ret = sortSSMParametersByUpdateTime([
        {
          Name: 'WG113',
          LastModifiedDate: undefined,
        },
        {
          Name: 'WG114',
          LastModifiedDate: dt,
        },
      ]);

      expect(ret[0].LastModifiedDate).toEqual(dt);
      expect(ret[1].LastModifiedDate).toBeUndefined();
    });

    it('valid undefined', async () => {
      const dt = moment(new Date()).toDate();
      const ret = sortSSMParametersByUpdateTime([
        {
          Name: 'WG113',
          LastModifiedDate: dt,
        },
        {
          Name: 'WG114',
          LastModifiedDate: undefined,
        },
      ]);

      expect(ret[0].LastModifiedDate).toEqual(dt);
      expect(ret[1].LastModifiedDate).toBeUndefined();
    });

    it('bigger smaller', async () => {
      const dt1 = moment(new Date()).add(50, 'seconds').toDate();
      const dt2 = moment(new Date()).subtract(50, 'seconds').toDate();
      const ret = sortSSMParametersByUpdateTime([
        {
          Name: 'WG113',
          LastModifiedDate: dt1,
        },
        {
          Name: 'WG114',
          LastModifiedDate: dt2,
        },
      ]);

      expect(ret[0].LastModifiedDate).toEqual(dt2);
      expect(ret[1].LastModifiedDate).toEqual(dt1);
    });

    it('smaller bigger', async () => {
      const dt1 = moment(new Date()).add(50, 'seconds').toDate();
      const dt2 = moment(new Date()).subtract(50, 'seconds').toDate();
      const ret = sortSSMParametersByUpdateTime([
        {
          Name: 'WG113',
          LastModifiedDate: dt2,
        },
        {
          Name: 'WG114',
          LastModifiedDate: dt1,
        },
      ]);

      expect(ret[0].LastModifiedDate).toEqual(dt2);
      expect(ret[1].LastModifiedDate).toEqual(dt1);
    });

    it('equal', async () => {
      const launchTime = moment(new Date()).subtract(50, 'seconds').toDate();
      const ret = sortSSMParametersByUpdateTime([
        {
          Name: 'WG113',
          LastModifiedDate: launchTime,
        },
        {
          Name: 'WG113',
          LastModifiedDate: launchTime,
        },
      ]);

      expect(ret[0].LastModifiedDate).toEqual(launchTime);
      expect(ret[1].LastModifiedDate).toEqual(launchTime);
    });
  });

  describe('runnerMinimumTimeExceeded', () => {
    it('launchTime === undefined', () => {
      const response = runnerMinimumTimeExceeded({
        awsRegion: baseConfig.awsRegion,
        instanceId: 'AGDGADUWG113',
        launchTime: undefined,
      });
      expect(response).toEqual(false);
    });

    it('exceeded minimum time', () => {
      const response = runnerMinimumTimeExceeded({
        awsRegion: baseConfig.awsRegion,
        instanceId: 'AGDGADUWG113',
        launchTime: moment(new Date())
          .utc()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      });
      expect(response).toEqual(true);
    });

    it('dont exceeded minimum time', () => {
      const response = runnerMinimumTimeExceeded({
        awsRegion: baseConfig.awsRegion,
        instanceId: 'AGDGADUWG113',
        launchTime: moment(new Date())
          .utc()
          .subtract(minimumRunningTimeInMinutes - 5, 'minutes')
          .toDate(),
      });
      expect(response).toEqual(false);
    });
  });

  describe('isRunnerRemovable', () => {
    describe('ghRunner === undefined', () => {
      it('launchTime === undefined', () => {
        const response = isRunnerRemovable(
          undefined,
          {
            awsRegion: baseConfig.awsRegion,
            instanceId: 'AGDGADUWG113',
            launchTime: undefined,
          },
          metrics,
        );
        expect(response).toEqual(false);
      });

      it('exceeded minimum time', () => {
        const response = isRunnerRemovable(
          undefined,
          {
            awsRegion: baseConfig.awsRegion,
            instanceId: 'AGDGADUWG113',
            launchTime: moment(new Date())
              .utc()
              .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
              .toDate(),
          },
          metrics,
        );
        expect(response).toEqual(true);
      });

      it('dont exceeded minimum time', () => {
        const response = isRunnerRemovable(
          undefined,
          {
            awsRegion: baseConfig.awsRegion,
            instanceId: 'AGDGADUWG113',
            launchTime: moment(new Date())
              .utc()
              .subtract(minimumRunningTimeInMinutes - 5, 'minutes')
              .toDate(),
          },
          metrics,
        );
        expect(response).toEqual(false);
      });
    });

    describe('ghRunner !== undefined', () => {
      it('ghRunner.busy == true', () => {
        const response = isRunnerRemovable(
          {
            busy: true,
          } as GhRunner,
          {
            awsRegion: baseConfig.awsRegion,
            instanceId: 'AGDGADUWG113',
            launchTime: undefined,
          },
          metrics,
        );
        expect(response).toEqual(false);
      });

      it('ghRunner.busy == false, launchTime === undefined', () => {
        const response = isRunnerRemovable(
          {
            busy: false,
          } as GhRunner,
          {
            awsRegion: baseConfig.awsRegion,
            instanceId: 'AGDGADUWG113',
            launchTime: undefined,
          },
          metrics,
        );
        expect(response).toEqual(false);
      });

      it('ghRunner.busy == false, launchTime exceeds', () => {
        const response = isRunnerRemovable(
          {
            busy: false,
          } as GhRunner,
          {
            awsRegion: baseConfig.awsRegion,
            instanceId: 'AGDGADUWG113',
            launchTime: moment(new Date())
              .utc()
              .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
              .toDate(),
          },
          metrics,
        );
        expect(response).toEqual(true);
      });

      it('ghRunner.busy == false, launchTime dont exceeds', () => {
        const response = isRunnerRemovable(
          {
            busy: false,
          } as GhRunner,
          {
            awsRegion: baseConfig.awsRegion,
            instanceId: 'AGDGADUWG113',
            launchTime: moment(new Date())
              .utc()
              .subtract(minimumRunningTimeInMinutes - 5, 'minutes')
              .toDate(),
          },
          metrics,
        );
        expect(response).toEqual(false);
      });
    });
  });

  describe('isEphemeralRunner', () => {
    it('ec2runner.runnerType === undefined', async () => {
      expect(isEphemeralRunner({ runnerType: undefined } as RunnerInfo, metrics)).resolves.toEqual(false);
    });

    describe('org runners', () => {
      const scaleConfigRepo = 'test-infra';
      const runnerType = 'runnerTypeDef';

      beforeEach(() => {
        jest.spyOn(Config, 'Instance', 'get').mockImplementation(
          () =>
            ({
              ...baseConfig,
              enableOrganizationRunners: true,
              scaleConfigRepo: scaleConfigRepo,
            } as unknown as Config),
        );
      });

      it('org in runner, is_ephemeral === undefined', async () => {
        const owner = 'the-org';
        const mockedGetRunnerTypes = mocked(getRunnerTypes);

        mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, {} as RunnerType]]));

        expect(await isEphemeralRunner({ runnerType: runnerType, org: owner } as RunnerInfo, metrics)).toEqual(false);

        expect(mockedGetRunnerTypes).toBeCalledTimes(1);
        expect(mockedGetRunnerTypes).toBeCalledWith({ owner: owner, repo: scaleConfigRepo }, metrics);
      });

      it('org in runner, is_ephemeral === false', async () => {
        const owner = 'the-org';
        const mockedGetRunnerTypes = mocked(getRunnerTypes);

        mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, { is_ephemeral: false } as RunnerType]]));

        expect(await isEphemeralRunner({ runnerType: runnerType, org: owner } as RunnerInfo, metrics)).toEqual(false);

        expect(mockedGetRunnerTypes).toBeCalledTimes(1);
        expect(mockedGetRunnerTypes).toBeCalledWith({ owner: owner, repo: scaleConfigRepo }, metrics);
      });

      it('org not in runner, is_ephemeral === true', async () => {
        const owner = 'the-org';
        const mockedGetRunnerTypes = mocked(getRunnerTypes);

        mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, { is_ephemeral: true } as RunnerType]]));

        expect(
          await isEphemeralRunner({ runnerType: runnerType, repo: `${owner}/a-repo` } as RunnerInfo, metrics),
        ).toEqual(true);

        expect(mockedGetRunnerTypes).toBeCalledTimes(1);
        expect(mockedGetRunnerTypes).toBeCalledWith({ owner: owner, repo: scaleConfigRepo }, metrics);
      });
    });

    describe('repo runners', () => {
      const runnerType = 'runnerTypeDef';
      const owner = 'the-org';
      const runnerRepo: Repo = {
        owner: owner,
        repo: 'a-repo',
      };
      const runnerRepoKey = `${owner}/a-repo`;

      describe('When no scaleConfigRepo is set, the runner repo is used as the source for scale config', () => {
        beforeEach(() => {
          jest.spyOn(Config, 'Instance', 'get').mockImplementation(
            () =>
              ({
                ...baseConfig,
                enableOrganizationRunners: false,
              } as unknown as Config),
          );
        });

        it('is_ephemeral === undefined', async () => {
          const mockedGetRunnerTypes = mocked(getRunnerTypes);

          mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, {} as RunnerType]]));

          expect(
            await isEphemeralRunner({ runnerType: runnerType, repo: runnerRepoKey } as RunnerInfo, metrics),
          ).toEqual(false);

          expect(mockedGetRunnerTypes).toBeCalledTimes(1);
          expect(mockedGetRunnerTypes).toBeCalledWith(runnerRepo, metrics);
        });

        it('is_ephemeral === true', async () => {
          const mockedGetRunnerTypes = mocked(getRunnerTypes);

          mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, { is_ephemeral: true } as RunnerType]]));

          expect(
            await isEphemeralRunner({ runnerType: runnerType, repo: runnerRepoKey } as RunnerInfo, metrics),
          ).toEqual(true);

          expect(mockedGetRunnerTypes).toBeCalledTimes(1);
          expect(mockedGetRunnerTypes).toBeCalledWith(runnerRepo, metrics);
        });

        it('is_ephemeral === false', async () => {
          const mockedGetRunnerTypes = mocked(getRunnerTypes);

          mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, { is_ephemeral: false } as RunnerType]]));

          expect(
            await isEphemeralRunner({ runnerType: runnerType, repo: runnerRepoKey } as RunnerInfo, metrics),
          ).toEqual(false);

          expect(mockedGetRunnerTypes).toBeCalledTimes(1);
          expect(mockedGetRunnerTypes).toBeCalledWith(runnerRepo, metrics);
        });
      });

      describe("When a scaleConfigRepo is set, it's used as the source for scale config", () => {
        const centralRepoName = 'central-repo'; // to be the test-infra equivalent
        const centralRepo: Repo = {
          owner: owner,
          repo: centralRepoName,
        };

        beforeEach(() => {
          jest.spyOn(Config, 'Instance', 'get').mockImplementation(
            () =>
              ({
                ...baseConfig,
                enableOrganizationRunners: false,
                scaleConfigRepo: centralRepoName,
              } as unknown as Config),
          );
        });

        it('is_ephemeral === undefined', async () => {
          const mockedGetRunnerTypes = mocked(getRunnerTypes);

          mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, {} as RunnerType]]));

          expect(
            await isEphemeralRunner({ runnerType: runnerType, repo: runnerRepoKey } as RunnerInfo, metrics),
          ).toEqual(false);

          expect(mockedGetRunnerTypes).toBeCalledTimes(1);
          expect(mockedGetRunnerTypes).toBeCalledWith(centralRepo, metrics);
        });

        it('is_ephemeral === true', async () => {
          const mockedGetRunnerTypes = mocked(getRunnerTypes);

          mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, { is_ephemeral: true } as RunnerType]]));

          expect(
            await isEphemeralRunner({ runnerType: runnerType, repo: runnerRepoKey } as RunnerInfo, metrics),
          ).toEqual(true);

          expect(mockedGetRunnerTypes).toBeCalledTimes(1);
          expect(mockedGetRunnerTypes).toBeCalledWith(centralRepo, metrics);
        });

        it('is_ephemeral === false', async () => {
          const mockedGetRunnerTypes = mocked(getRunnerTypes);

          mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, { is_ephemeral: false } as RunnerType]]));

          expect(
            await isEphemeralRunner({ runnerType: runnerType, repo: runnerRepoKey } as RunnerInfo, metrics),
          ).toEqual(false);

          expect(mockedGetRunnerTypes).toBeCalledTimes(1);
          expect(mockedGetRunnerTypes).toBeCalledWith(centralRepo, metrics);
        });
      });
    });
  });

  describe('minRunners', () => {
    const runnerType = 'runnerTypeDef';

    it('min_runners === 2', async () => {
      const mockedGetRunnerTypes = mocked(getRunnerTypes);
      mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, { min_available: 2 } as RunnerType]]));
      expect(await minRunners({ runnerType: runnerType, repo: 'the-org/a-repo' } as RunnerInfo, metrics)).toBe(2);
    });
  });

  describe('getGHRunnerRepo', () => {
    const ghRunners = [
      { name: 'instance-id-01', busy: true },
      { name: 'instance-id-02', busy: false },
    ] as GhRunners;
    const repo: Repo = {
      owner: 'the-org',
      repo: 'a-repo',
    };
    const repoKey = `the-org/a-repo`;

    it('finds on listGithubRunnersRepo, busy === true', async () => {
      const mockedListGithubRunnersRepo = mocked(listGithubRunnersRepo);
      const ec2runner: RunnerInfo = {
        awsRegion: baseConfig.awsRegion,
        repo: repoKey,
        instanceId: 'instance-id-01',
        runnerType: 'runnerType-01',
        ghRunnerId: 'ghRunnerId-01',
      };

      mockedListGithubRunnersRepo.mockResolvedValueOnce(ghRunners);

      expect(await getGHRunnerRepo(ec2runner, metrics)).toEqual(ghRunners[0]);

      expect(mockedListGithubRunnersRepo).toBeCalledTimes(1);
      expect(mockedListGithubRunnersRepo).toBeCalledWith(repo, metrics);
    });

    it('dont finds on listGithubRunnersRep, finds with getRunnerRepo, busy === false', async () => {
      const mockedListGithubRunnersRepo = mocked(listGithubRunnersRepo);
      const mockedGetRunnerRepo = mocked(getRunnerRepo);
      const ec2runner: RunnerInfo = {
        awsRegion: baseConfig.awsRegion,
        repo: repoKey,
        instanceId: 'instance-id-03',
        runnerType: 'runnerType-01',
        ghRunnerId: 'ghRunnerId-01',
      };
      const theGhRunner = { name: 'instance-id-03', busy: false } as GhRunner;

      mockedListGithubRunnersRepo.mockResolvedValueOnce(ghRunners);
      mockedGetRunnerRepo.mockResolvedValueOnce(theGhRunner);

      expect(await getGHRunnerRepo(ec2runner, metrics)).toEqual(theGhRunner);

      expect(mockedListGithubRunnersRepo).toBeCalledTimes(1);
      expect(mockedListGithubRunnersRepo).toBeCalledWith(repo, metrics);
      expect(mockedGetRunnerRepo).toBeCalledTimes(1);
      expect(mockedGetRunnerRepo).toBeCalledWith(repo, ec2runner.ghRunnerId, metrics);
    });

    it('listGithubRunnersRep and getRunnerRepo throws exception', async () => {
      const mockedListGithubRunnersRepo = mocked(listGithubRunnersRepo);
      const mockedGetRunnerRepo = mocked(getRunnerRepo);
      const ec2runner: RunnerInfo = {
        awsRegion: baseConfig.awsRegion,
        repo: repoKey,
        instanceId: 'instance-id-03',
        runnerType: 'runnerType-01',
        ghRunnerId: 'ghRunnerId-01',
      };

      mockedListGithubRunnersRepo.mockRejectedValueOnce('Error');
      mockedGetRunnerRepo.mockRejectedValueOnce('Error');

      expect(await getGHRunnerRepo(ec2runner, metrics)).toBeUndefined();

      expect(mockedListGithubRunnersRepo).toBeCalledTimes(1);
      expect(mockedListGithubRunnersRepo).toBeCalledWith(repo, metrics);
      expect(mockedGetRunnerRepo).toBeCalledTimes(1);
      expect(mockedGetRunnerRepo).toBeCalledWith(repo, ec2runner.ghRunnerId, metrics);
    });
  });

  describe('cleanupOldSSMParameters', () => {
    it('Stops when LastModifiedDate === undefined', async () => {
      const oldDt = moment()
        .subtract(Config.Instance.sSMParamCleanupAgeDays + 1, 'days')
        .toDate();
      const ssmParameters = new Map<string, SSM.ParameterMetadata>();
      ssmParameters.set('WG113', { Name: 'WG113', LastModifiedDate: undefined });
      ssmParameters.set('WG115', { Name: 'WG115', LastModifiedDate: oldDt });
      ssmParameters.set('WG116', { Name: 'WG116', LastModifiedDate: oldDt });

      const mockedDoDeleteSSMParameter = mocked(doDeleteSSMParameter);
      const mockedListSSMParameters = mocked(listSSMParameters);

      mockedListSSMParameters.mockResolvedValueOnce(ssmParameters);
      mockedDoDeleteSSMParameter.mockResolvedValue(true);

      await cleanupOldSSMParameters(new Set(['us-east-1']), metrics);

      expect(mockedDoDeleteSSMParameter).toBeCalledTimes(2);
      expect(mockedDoDeleteSSMParameter).toBeCalledWith('WG115', metrics, 'us-east-1');
      expect(mockedDoDeleteSSMParameter).toBeCalledWith('WG116', metrics, 'us-east-1');
      expect(mockedListSSMParameters).toBeCalledTimes(1);
    });

    it('Stops when LastModifiedDate is < Config.Instance.sSMParamCleanupAgeDays', async () => {
      const oldDt = moment()
        .subtract(Config.Instance.sSMParamCleanupAgeDays + 1, 'days')
        .toDate();
      const olderDt = moment()
        .subtract(Config.Instance.sSMParamCleanupAgeDays - 1, 'days')
        .toDate();
      const ssmParameters = new Map<string, SSM.ParameterMetadata>();
      ssmParameters.set('WG113', { Name: 'WG113', LastModifiedDate: undefined });
      ssmParameters.set('WG115', { Name: 'WG115', LastModifiedDate: oldDt });
      ssmParameters.set('WG116', { Name: 'WG116', LastModifiedDate: olderDt });

      const mockedDoDeleteSSMParameter = mocked(doDeleteSSMParameter);
      const mockedListSSMParameters = mocked(listSSMParameters);

      mockedListSSMParameters.mockResolvedValueOnce(ssmParameters);
      mockedDoDeleteSSMParameter.mockResolvedValue(true);

      await cleanupOldSSMParameters(new Set(['us-east-1']), metrics);

      expect(mockedDoDeleteSSMParameter).toBeCalledTimes(1);
      expect(mockedDoDeleteSSMParameter).toBeCalledWith('WG115', metrics, 'us-east-1');
      expect(mockedListSSMParameters).toBeCalledTimes(1);
    });

    it('Stops when deleted >= Config.Instance.sSMParamMaxCleanupAllowance', async () => {
      const oldDt = moment()
        .subtract(Config.Instance.sSMParamCleanupAgeDays + 1, 'days')
        .toDate();
      const ssmParameters = new Map<string, SSM.ParameterMetadata>();
      [...Array(MAX_SSM_PARAMETERS + 5).keys()].forEach((i) => {
        const name = `AGDGADUWG113-${i}`;
        ssmParameters.set(name, { Name: name, LastModifiedDate: oldDt });
      });

      const mockedDoDeleteSSMParameter = mocked(doDeleteSSMParameter);
      const mockedListSSMParameters = mocked(listSSMParameters);

      mockedListSSMParameters.mockResolvedValueOnce(ssmParameters);
      mockedDoDeleteSSMParameter.mockResolvedValue(true);

      await cleanupOldSSMParameters(new Set(['us-east-1']), metrics);

      expect(mockedDoDeleteSSMParameter).toBeCalledTimes(MAX_SSM_PARAMETERS);
      expect(mockedListSSMParameters).toBeCalledTimes(1);
    });

    it('Breaks when deleted >= Config.Instance.sSMParamMaxCleanupAllowance', async () => {
      const oldDt = moment()
        .subtract(Config.Instance.sSMParamCleanupAgeDays + 1, 'days')
        .toDate();
      const ssmParameters = new Map<string, SSM.ParameterMetadata>();
      [...Array(MAX_SSM_PARAMETERS + 5).keys()].forEach((i) => {
        const name = `AGDGADUWG113-${i}`;
        ssmParameters.set(name, { Name: name, LastModifiedDate: oldDt });
      });

      const mockedDoDeleteSSMParameter = mocked(doDeleteSSMParameter);
      const mockedListSSMParameters = mocked(listSSMParameters);

      mockedListSSMParameters.mockResolvedValueOnce(ssmParameters);
      mockedDoDeleteSSMParameter.mockResolvedValue(true);

      await cleanupOldSSMParameters(new Set(['us-east-1']), metrics);

      expect(mockedDoDeleteSSMParameter).toBeCalledTimes(MAX_SSM_PARAMETERS);
      expect(mockedListSSMParameters).toBeCalledTimes(1);
    });

    it('Dont count failed to delete', async () => {
      const oldDt = moment()
        .subtract(Config.Instance.sSMParamCleanupAgeDays + 1, 'days')
        .toDate();
      const ssmParameters = new Map<string, SSM.ParameterMetadata>();
      [...Array(MAX_SSM_PARAMETERS + 5).keys()].forEach((i) => {
        const name = `AGDGADUWG113-${i}`;
        ssmParameters.set(name, { Name: name, LastModifiedDate: oldDt });
      });

      const mockedDoDeleteSSMParameter = mocked(doDeleteSSMParameter);
      const mockedListSSMParameters = mocked(listSSMParameters);

      mockedListSSMParameters.mockResolvedValueOnce(ssmParameters);
      mockedDoDeleteSSMParameter.mockResolvedValue(false);

      await cleanupOldSSMParameters(new Set(['us-east-1']), metrics);

      expect(mockedDoDeleteSSMParameter).toBeCalledTimes(MAX_SSM_PARAMETERS + 5);
      expect(mockedListSSMParameters).toBeCalledTimes(1);
    });
  });

  describe('getGHRunnerOrg', () => {
    const ghRunners = [
      { name: 'instance-id-01', busy: true },
      { name: 'instance-id-02', busy: false },
    ] as GhRunners;
    const org = 'the-org';

    it('finds on listGithubRunnersOrg, busy === true', async () => {
      const mockedListGithubRunnersOrg = mocked(listGithubRunnersOrg);
      const ec2runner: RunnerInfo = {
        awsRegion: baseConfig.awsRegion,
        org: org,
        instanceId: 'instance-id-01',
        runnerType: 'runnerType-01',
        ghRunnerId: 'ghRunnerId-01',
      };

      mockedListGithubRunnersOrg.mockResolvedValueOnce(ghRunners);

      expect(await getGHRunnerOrg(ec2runner, metrics)).toEqual(ghRunners[0]);

      expect(mockedListGithubRunnersOrg).toBeCalledTimes(1);
      expect(mockedListGithubRunnersOrg).toBeCalledWith(org, metrics);
    });

    it('dont finds on listGithubRunnersOrg, finds with getRunnerOrg, busy === false', async () => {
      const mockedListGithubRunnersOrg = mocked(listGithubRunnersOrg);
      const mockedGetRunnerOrg = mocked(getRunnerOrg);
      const ec2runner: RunnerInfo = {
        awsRegion: baseConfig.awsRegion,
        org: org,
        instanceId: 'instance-id-03',
        runnerType: 'runnerType-01',
        ghRunnerId: 'ghRunnerId-01',
      };
      const theGhRunner = { name: 'instance-id-03', busy: false } as GhRunner;

      mockedListGithubRunnersOrg.mockResolvedValueOnce(ghRunners);
      mockedGetRunnerOrg.mockResolvedValueOnce(theGhRunner);

      expect(await getGHRunnerOrg(ec2runner, metrics)).toEqual(theGhRunner);

      expect(mockedListGithubRunnersOrg).toBeCalledTimes(1);
      expect(mockedListGithubRunnersOrg).toBeCalledWith(org, metrics);
      expect(mockedGetRunnerOrg).toBeCalledTimes(1);
      expect(mockedGetRunnerOrg).toBeCalledWith(org, ec2runner.ghRunnerId, metrics);
    });

    it('listGithubRunnersRep and getRunnerRepo throws exception', async () => {
      const mockedListGithubRunnersOrg = mocked(listGithubRunnersOrg);
      const mockedGetRunnerOrg = mocked(getRunnerOrg);
      const ec2runner: RunnerInfo = {
        awsRegion: baseConfig.awsRegion,
        org: org,
        instanceId: 'instance-id-03',
        runnerType: 'runnerType-01',
        ghRunnerId: 'ghRunnerId-01',
      };

      mockedListGithubRunnersOrg.mockRejectedValueOnce('Error');
      mockedGetRunnerOrg.mockRejectedValueOnce('Error');

      expect(await getGHRunnerOrg(ec2runner, metrics)).toBeUndefined();

      expect(mockedListGithubRunnersOrg).toBeCalledTimes(1);
      expect(mockedListGithubRunnersOrg).toBeCalledWith(org, metrics);
      expect(mockedGetRunnerOrg).toBeCalledTimes(1);
      expect(mockedGetRunnerOrg).toBeCalledWith(org, ec2runner.ghRunnerId, metrics);
    });

    it('getRunner throws when api rate limit is hit', async () => {
      const mockedListGithubRunnersOrg = mocked(listGithubRunnersOrg);

      mockedListGithubRunnersOrg.mockRejectedValueOnce(
        new RequestError('API rate limit exceeded for installation ID 13954108.', 403, {
          headers: {
            'access-control-allow-origin': '*',
            'x-ratelimit-limit': '20000',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1666378232',
            'x-ratelimit-resource': 'core',
            'x-ratelimit-used': '20006',
            'x-xss-protection': '0',
          },
          request: {
            method: 'GET',
            url: 'https://api.github.com/orgs/pytorch/actions/runners?per_page=100',
            headers: {
              accept: 'application/vnd.github.v3+json',
            },
          },
        }),
      );

      const ec2runner: RunnerInfo = {
        awsRegion: baseConfig.awsRegion,
        org: org,
        instanceId: 'instance-id-03',
        runnerType: 'runnerType-01',
        ghRunnerId: 'ghRunnerId-01',
      };

      await expect(getGHRunnerOrg(ec2runner, metrics)).rejects.toThrow(RequestError);
    });
  });
});

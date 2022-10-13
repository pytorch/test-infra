import moment from 'moment';
import nock from 'nock';
import { mocked } from 'ts-jest/utils';
import { Config } from './config';
import { resetSecretCache } from './gh-auth';
import { RunnerInfo, Repo } from './utils';
import {
  GhRunner,
  GhRunners,
  getRunnerOrg,
  getRunnerRepo,
  getRunnerTypes,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
  removeGithubRunnerOrg,
  removeGithubRunnerRepo,
  resetGHRunnersCaches,
} from './gh-runners';
import * as MetricsModule from './metrics';
import { listRunners, resetRunnersCaches, terminateRunner, RunnerType } from './runners';
import {
  getGHRunnerOrg,
  getGHRunnerRepo,
  isEphemeralRunner,
  isRunnerRemovable,
  runnerMinimumTimeExceeded,
  scaleDown,
  sortRunnersByLaunchTime,
} from './scale-down';

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
  listRunners: jest.fn(),
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

const metrics = new MetricsModule.ScaleDownMetrics();

const minimumRunningTimeInMinutes = 10;
const environment = 'environment';
const baseConfig = {
  minimumRunningTimeInMinutes: minimumRunningTimeInMinutes,
  environment: environment,
  minAvailableRunners: 0,
};

describe('scale-down', () => {
  beforeEach(() => {
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseConfig as Config);
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
      mockRunner({ id: '0001', name: 'keep-this-not-min-time-01', busy: false }),
      mockRunner({ id: '0002', name: 'keep-this-not-min-time-02', busy: false }),
      mockRunner({ id: '0003', name: 'keep-this-is-busy-01', busy: true }),
      mockRunner({ id: '0004', name: 'keep-this-is-busy-02', busy: true }),
      mockRunner({ id: '0005', name: 'keep-this-not-min-time-03', busy: false }),
      mockRunner({ id: '0006', name: 'keep-this-is-busy-03', busy: true }),
      mockRunner({ id: '0007', name: 'remove-ephemeral-01', busy: false }),
      mockRunner({ id: '0008', name: 'keep-min-runners-not-oldest-01', busy: false }),
      mockRunner({ id: '0009', name: 'keep-min-runners-oldest-01', busy: false }),
      mockRunner({ id: '0010', name: 'keep-min-runners-not-oldest-02', busy: false }),
      mockRunner({ id: '0011', name: 'keep-min-runners-oldest-02', busy: false }),
      mockRunner({ id: '0012', name: 'keep-lt-min-no-ghrunner-01', busy: false }),
    ] as GhRunners;
    const listRunnersRet = [
      {
        runnerType: 'ignore-no-org-no-repo',
        instanceId: '001',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'ignore-no-org-no-repo',
        instanceId: '002',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 3, 'minutes')
          .toDate(),
      },

      {
        runnerType: 'ignore-no-org',
        instanceId: '003',
        repo: 'a-owner/a-repo',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 3, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'ignore-no-org',
        instanceId: '004',
        repo: 'a-owner/a-repo',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 3, 'minutes')
          .toDate(),
      },

      {
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-not-min-time-01',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-not-min-time-02',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 3, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-is-busy-01',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-is-busy-02',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },

      {
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-this-not-min-time-03',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-this-is-busy-03',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'a-ephemeral-runner',
        instanceId: 'remove-ephemeral-01', // X
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'a-ephemeral-runner',
        instanceId: 'remove-ephemeral-02', // X
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },

      {
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-not-oldest-01',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-oldest-01', // X
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 7, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-not-oldest-02',
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 6, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-oldest-02', // X
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 8, 'minutes')
          .toDate(),
      },

      {
        runnerType: 'keep-lt-min-no-ghrunner',
        instanceId: 'keep-lt-min-no-ghrunner-no-ghr-01', // X
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-lt-min-no-ghrunner',
        instanceId: 'keep-lt-min-no-ghrunner-no-ghr-02', // X
        org: theOrg,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 7, 'minutes')
          .toDate(),
      },
      {
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
          } as Config),
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

      await scaleDown();

      expect(mockedListRunners).toBeCalledTimes(1);
      expect(mockedListRunners).toBeCalledWith(metrics, { environment: environment });

      expect(mockedListGithubRunnersOrg).toBeCalledTimes(15);
      expect(mockedListGithubRunnersOrg).toBeCalledWith(theOrg, metrics);

      expect(mockedGetRunnerTypes).toBeCalledTimes(3);
      expect(mockedGetRunnerTypes).toBeCalledWith({ owner: theOrg, repo: scaleConfigRepo }, metrics);

      expect(mockedRemoveGithubRunnerOrg).toBeCalledTimes(3);
      {
        const { awsR, ghR } = getRunnerPair('keep-min-runners-oldest-02');
        expect(mockedRemoveGithubRunnerOrg).toBeCalledWith(awsR, ghR.id, awsR.org as string, metrics);
      }
      {
        const { awsR, ghR } = getRunnerPair('keep-min-runners-oldest-01');
        expect(mockedRemoveGithubRunnerOrg).toBeCalledWith(awsR, ghR.id, awsR.org as string, metrics);
      }
      {
        const { awsR, ghR } = getRunnerPair('remove-ephemeral-01');
        expect(mockedRemoveGithubRunnerOrg).toBeCalledWith(awsR, ghR.id, awsR.org as string, metrics);
      }

      expect(mockedTerminateRunner).toBeCalledTimes(6);
      {
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const { awsR, ghR } = getRunnerPair('keep-lt-min-no-ghrunner-no-ghr-02');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const { awsR, ghR } = getRunnerPair('keep-lt-min-no-ghrunner-no-ghr-01');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const { awsR, ghR } = getRunnerPair('keep-min-runners-oldest-02');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const { awsR, ghR } = getRunnerPair('keep-min-runners-oldest-01');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const { awsR, ghR } = getRunnerPair('remove-ephemeral-02');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const { awsR, ghR } = getRunnerPair('remove-ephemeral-01');
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
      mockRunner({ id: '0001', name: 'keep-this-not-min-time-01', busy: false }),
      mockRunner({ id: '0002', name: 'keep-this-not-min-time-02', busy: false }),
      mockRunner({ id: '0003', name: 'keep-this-is-busy-01', busy: true }),
      mockRunner({ id: '0004', name: 'keep-this-is-busy-02', busy: true }),
      mockRunner({ id: '0005', name: 'keep-this-not-min-time-03', busy: false }),
      mockRunner({ id: '0006', name: 'keep-this-is-busy-03', busy: true }),
      mockRunner({ id: '0007', name: 'remove-ephemeral-01', busy: false }),
      mockRunner({ id: '0008', name: 'keep-min-runners-not-oldest-01', busy: false }),
      mockRunner({ id: '0009', name: 'keep-min-runners-oldest-01', busy: false }),
      mockRunner({ id: '0010', name: 'keep-min-runners-not-oldest-02', busy: false }),
      mockRunner({ id: '0011', name: 'keep-min-runners-oldest-02', busy: false }),
      mockRunner({ id: '0012', name: 'keep-lt-min-no-ghrunner-01', busy: false }),
    ] as GhRunners;
    const listRunnersRet = [
      {
        runnerType: 'ignore-no-org-no-repo',
        instanceId: '001',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'ignore-no-org-no-repo',
        instanceId: '002',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 3, 'minutes')
          .toDate(),
      },

      {
        runnerType: 'ignore-no-repo',
        instanceId: '003',
        org: 'a-owner',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 3, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'ignore-no-repo',
        instanceId: '004',
        org: 'a-owner',
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 3, 'minutes')
          .toDate(),
      },

      {
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-not-min-time-01',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-not-min-time-02',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 3, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-is-busy-01',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-all-4',
        instanceId: 'keep-this-is-busy-02',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },

      {
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-this-not-min-time-03',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes - 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'a-ephemeral-runner',
        instanceId: 'keep-this-is-busy-03',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'a-ephemeral-runner',
        instanceId: 'remove-ephemeral-01', // X
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'a-ephemeral-runner',
        instanceId: 'remove-ephemeral-02', // X
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },

      {
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-not-oldest-01',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-oldest-01', // X
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 7, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-not-oldest-02',
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 6, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-min-runners-oldest',
        instanceId: 'keep-min-runners-oldest-02', // X
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 8, 'minutes')
          .toDate(),
      },

      {
        runnerType: 'keep-lt-min-no-ghrunner',
        instanceId: 'keep-lt-min-no-ghrunner-no-ghr-01', // X
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
      {
        runnerType: 'keep-lt-min-no-ghrunner',
        instanceId: 'keep-lt-min-no-ghrunner-no-ghr-02', // X
        repo: theRepo,
        launchTime: dateRef
          .clone()
          .subtract(minimumRunningTimeInMinutes + 7, 'minutes')
          .toDate(),
      },
      {
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
          } as Config),
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

      await scaleDown();

      expect(mockedListRunners).toBeCalledTimes(1);
      expect(mockedListRunners).toBeCalledWith(metrics, { environment: environment });

      expect(mockedListGithubRunnersRepo).toBeCalledTimes(15);
      expect(mockedListGithubRunnersRepo).toBeCalledWith(repo, metrics);

      expect(mockedGetRunnerTypes).toBeCalledTimes(3);
      expect(mockedGetRunnerTypes).toBeCalledWith(repo, metrics);

      expect(mockedRemoveGithubRunnerRepo).toBeCalledTimes(3);
      {
        const { awsR, ghR } = getRunnerPair('keep-min-runners-oldest-02');
        expect(mockedRemoveGithubRunnerRepo).toBeCalledWith(awsR, ghR.id, repo, metrics);
      }
      {
        const { awsR, ghR } = getRunnerPair('keep-min-runners-oldest-01');
        expect(mockedRemoveGithubRunnerRepo).toBeCalledWith(awsR, ghR.id, repo, metrics);
      }
      {
        const { awsR, ghR } = getRunnerPair('remove-ephemeral-01');
        expect(mockedRemoveGithubRunnerRepo).toBeCalledWith(awsR, ghR.id, repo, metrics);
      }

      expect(mockedTerminateRunner).toBeCalledTimes(6);
      {
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const { awsR, ghR } = getRunnerPair('keep-lt-min-no-ghrunner-no-ghr-02');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const { awsR, ghR } = getRunnerPair('keep-lt-min-no-ghrunner-no-ghr-01');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const { awsR, ghR } = getRunnerPair('keep-min-runners-oldest-02');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const { awsR, ghR } = getRunnerPair('keep-min-runners-oldest-01');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const { awsR, ghR } = getRunnerPair('remove-ephemeral-02');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
      {
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const { awsR, ghR } = getRunnerPair('remove-ephemeral-01');
        expect(mockedTerminateRunner).toBeCalledWith(awsR, metrics);
      }
    });
  });

  describe('sortRunnersByLaunchTime', () => {
    it('two undefined', async () => {
      const ret = sortRunnersByLaunchTime([
        {
          instanceId: 'WG113',
          repo: undefined,
          launchTime: undefined,
        },
        {
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
          instanceId: 'WG113',
          repo: undefined,
          launchTime: undefined,
        },
        {
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
          instanceId: 'WG113',
          repo: undefined,
          launchTime: dt,
        },
        {
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
          instanceId: 'WG113',
          repo: undefined,
          launchTime: dt1,
        },
        {
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
          instanceId: 'WG113',
          repo: undefined,
          launchTime: dt2,
        },
        {
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
          instanceId: 'WG113',
          repo: undefined,
          launchTime: launchTime,
        },
        {
          instanceId: 'WG113',
          repo: undefined,
          launchTime: launchTime,
        },
      ]);

      expect(ret[0].launchTime).toEqual(launchTime);
      expect(ret[1].launchTime).toEqual(launchTime);
    });
  });

  describe('runnerMinimumTimeExceeded', () => {
    it('launchTime === undefined', () => {
      const response = runnerMinimumTimeExceeded({
        instanceId: 'AGDGADUWG113',
        launchTime: undefined,
      });
      expect(response).toEqual(false);
    });

    it('exceeded minimum time', () => {
      const response = runnerMinimumTimeExceeded({
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
            } as Config),
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
      const repo: Repo = {
        owner: owner,
        repo: 'a-repo',
      };
      const repoKey = `${owner}/a-repo`;

      beforeEach(() => {
        jest.spyOn(Config, 'Instance', 'get').mockImplementation(
          () =>
            ({
              ...baseConfig,
              enableOrganizationRunners: false,
            } as Config),
        );
      });

      it('is_ephemeral === undefined', async () => {
        const mockedGetRunnerTypes = mocked(getRunnerTypes);

        mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, {} as RunnerType]]));

        expect(await isEphemeralRunner({ runnerType: runnerType, repo: repoKey } as RunnerInfo, metrics)).toEqual(
          false,
        );

        expect(mockedGetRunnerTypes).toBeCalledTimes(1);
        expect(mockedGetRunnerTypes).toBeCalledWith(repo, metrics);
      });

      it('is_ephemeral === true', async () => {
        const mockedGetRunnerTypes = mocked(getRunnerTypes);

        mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, { is_ephemeral: true } as RunnerType]]));

        expect(await isEphemeralRunner({ runnerType: runnerType, repo: repoKey } as RunnerInfo, metrics)).toEqual(true);

        expect(mockedGetRunnerTypes).toBeCalledTimes(1);
        expect(mockedGetRunnerTypes).toBeCalledWith(repo, metrics);
      });

      it('is_ephemeral === false', async () => {
        const mockedGetRunnerTypes = mocked(getRunnerTypes);

        mockedGetRunnerTypes.mockResolvedValueOnce(new Map([[runnerType, { is_ephemeral: false } as RunnerType]]));

        expect(await isEphemeralRunner({ runnerType: runnerType, repo: repoKey } as RunnerInfo, metrics)).toEqual(
          false,
        );

        expect(mockedGetRunnerTypes).toBeCalledTimes(1);
        expect(mockedGetRunnerTypes).toBeCalledWith(repo, metrics);
      });
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

  describe('getGHRunnerOrg', () => {
    const ghRunners = [
      { name: 'instance-id-01', busy: true },
      { name: 'instance-id-02', busy: false },
    ] as GhRunners;
    const org = 'the-org';

    it('finds on listGithubRunnersOrg, busy === true', async () => {
      const mockedListGithubRunnersOrg = mocked(listGithubRunnersOrg);
      const ec2runner: RunnerInfo = {
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
  });
});

import {
  GhRunners,
  getRunnerOrg,
  getRunnerRepo,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
  listRunners,
  removeGithubRunnerOrg,
  removeGithubRunnerRepo,
  resetRunnersCaches,
  terminateRunner,
} from './runners';

import { Config } from './config';
import { mocked } from 'ts-jest/utils';
import moment from 'moment';
import nock from 'nock';
import scaleDown from './scale-down';
import * as MetricsModule from './metrics';

jest.mock('./runners', () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any */
  ...(jest.requireActual('./runners') as any),
  getRunnerRepo: jest.fn(),
  getRunnerOrg: jest.fn(),
  listGithubRunnersRepo: jest.fn(),
  listGithubRunnersOrg: jest.fn(),
  listRunners: jest.fn(),
  removeGithubRunnerOrg: jest.fn(),
  removeGithubRunnerRepo: jest.fn(),
  resetRunnersCaches: jest.fn(),
  terminateRunner: jest.fn(),
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();
});

const metrics = new MetricsModule.ScaleDownMetrics();

describe('scaleDown', () => {
  const minimumRunningTimeInMinutes = 10;
  const environment = 'environment';

  beforeEach(() => {
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(
      () =>
        ({
          minimumRunningTimeInMinutes: minimumRunningTimeInMinutes,
          environment: environment,
        } as Config),
    );
    jest.spyOn(MetricsModule, 'ScaleDownMetrics').mockReturnValue(metrics);
    jest.spyOn(metrics, 'sendMetrics').mockImplementation(async () => {
      return;
    });
  });

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

  it('runners not live for minimum time', async () => {
    mocked(listRunners).mockResolvedValue([
      {
        instanceId: 'WG113',
        repo: 'owner/repo',
        launchTime: moment(new Date()).toDate(),
      },
    ]);
    const mockedResetRunnersCaches = mocked(resetRunnersCaches);

    await scaleDown();

    expect(mockedResetRunnersCaches).toBeCalledTimes(1);
  });

  describe('tests sorting - no particular goal here', () => {
    it('two undefined', async () => {
      mocked(listRunners).mockResolvedValue([
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

      await scaleDown();
    });

    it('undefined valid', async () => {
      mocked(listRunners).mockResolvedValue([
        {
          instanceId: 'WG113',
          repo: undefined,
          launchTime: undefined,
        },
        {
          instanceId: 'WG113',
          repo: undefined,
          launchTime: moment(new Date()).toDate(),
        },
      ]);

      await scaleDown();
    });

    it('valid undefined', async () => {
      mocked(listRunners).mockResolvedValue([
        {
          instanceId: 'WG113',
          repo: undefined,
          launchTime: moment(new Date()).toDate(),
        },
        {
          instanceId: 'WG113',
          repo: undefined,
          launchTime: undefined,
        },
      ]);

      await scaleDown();
    });

    it('bigger smaller', async () => {
      mocked(listRunners).mockResolvedValue([
        {
          instanceId: 'WG113',
          repo: undefined,
          launchTime: moment(new Date()).add(50, 'seconds').toDate(),
        },
        {
          instanceId: 'WG113',
          repo: undefined,
          launchTime: moment(new Date()).subtract(50, 'seconds').toDate(),
        },
      ]);

      await scaleDown();
    });

    it('smaller bigger', async () => {
      mocked(listRunners).mockResolvedValue([
        {
          instanceId: 'WG113',
          repo: undefined,
          launchTime: moment(new Date()).subtract(50, 'seconds').toDate(),
        },
        {
          instanceId: 'WG113',
          repo: undefined,
          launchTime: moment(new Date()).add(50, 'seconds').toDate(),
        },
      ]);

      await scaleDown();
    });

    it('equal', async () => {
      const launchTime = moment(new Date()).subtract(50, 'seconds').toDate();
      mocked(listRunners).mockResolvedValue([
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

      await scaleDown();
    });
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
    const mockedListGithubRunners = mocked(listGithubRunnersRepo);

    await scaleDown();

    expect(mockedResetRunnersCaches).toBeCalledTimes(1);
    expect(mockedListGithubRunners).not.toBeCalled();
  });

  describe('RunnerInfo.repo !== undefined', () => {
    it('listGithubRunnersRepo returns [], getRunnerRepo ret undefined and terminateRunner with success', async () => {
      const ec2runner = {
        instanceId: 'WG113',
        repo: 'owner/repo',
        launchTime: moment(new Date())
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
        ghRunnerId: '33',
      };
      const repo = { owner: 'owner', repo: 'repo' };
      mocked(listRunners).mockResolvedValue([ec2runner]);
      const mockedListGithubRunners = mocked(listGithubRunnersRepo).mockResolvedValue([]);
      const mockedGetRunner = mocked(getRunnerRepo).mockResolvedValue(undefined);
      const mockedTerminateRunner = mocked(terminateRunner);

      await scaleDown();

      expect(mockedListGithubRunners).toBeCalledWith(repo, metrics);
      expect(mockedGetRunner).toBeCalledWith(repo, ec2runner.ghRunnerId, metrics);
      expect(mockedTerminateRunner).toBeCalledWith(ec2runner, metrics);
    });

    it('listGithubRunnersRepo returns [], getRunnerRepo returns undefined and terminateRunner raises', async () => {
      const ec2runner = {
        instanceId: 'WG113',
        repo: 'owner/repo',
        launchTime: moment(new Date())
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
        ghRunnerId: '33',
      };
      mocked(listRunners).mockResolvedValue([ec2runner]);
      mocked(listGithubRunnersRepo).mockResolvedValue([]);
      mocked(getRunnerRepo).mockResolvedValue(undefined);
      const mockedTerminateRunner = mocked(terminateRunner).mockImplementation(async () => {
        throw Error('error on terminateRunner');
      });

      await scaleDown();

      expect(mockedTerminateRunner).toBeCalled();
    });

    it('listGithubRunnersRepo returns [(matches, nonbusy)], removeGithubRunnerRepo is called', async () => {
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
          busy: false,
          labels: [],
        },
      ];
      const repo = { owner: 'owner', repo: 'repo' };
      mocked(listRunners).mockResolvedValue([ec2runner]);
      mocked(listGithubRunnersRepo).mockResolvedValue(matchRunner);
      const mockedGetRunner = mocked(getRunnerRepo).mockResolvedValue(undefined);
      const mockedRemoveGithubRunner = mocked(removeGithubRunnerRepo);

      await scaleDown();

      expect(mockedGetRunner).not.toBeCalled();
      expect(mockedRemoveGithubRunner).toBeCalledWith(ec2runner, matchRunner[0].id, repo, metrics);
    });

    it('listGithubRunnersRepo returns [(matches, nonbusy)], removeGithubRunnerRepo is NOT called', async () => {
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
      mocked(listRunners).mockResolvedValue([ec2runner]);
      mocked(listGithubRunnersRepo).mockResolvedValue(matchRunner);
      const mockedRemoveGithubRunner = mocked(removeGithubRunnerRepo);

      await scaleDown();

      expect(mockedRemoveGithubRunner).not.toBeCalled();
    });
  });

  describe('RunnerInfo.org !== undefined', () => {
    it('listGithubRunnersOrg returns [], getRunnerOrg ret undefined and terminateRunner with success', async () => {
      const ec2runner = {
        instanceId: 'WG113',
        org: 'owner',
        launchTime: moment(new Date())
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
        ghRunnerId: '33',
      };
      mocked(listRunners).mockResolvedValue([ec2runner]);
      const mockedListGithubRunners = mocked(listGithubRunnersOrg).mockResolvedValue([]);
      const mockedGetRunner = mocked(getRunnerOrg).mockResolvedValue(undefined);
      const mockedTerminateRunner = mocked(terminateRunner);

      await scaleDown();

      expect(mockedListGithubRunners).toBeCalledWith('owner', metrics);
      expect(mockedGetRunner).toBeCalledWith('owner', ec2runner.ghRunnerId, metrics);
      expect(mockedTerminateRunner).toBeCalledWith(ec2runner, metrics);
    });

    it('listGithubRunnersOrg returns [], getRunnerOrg returns undefined and terminateRunner raises', async () => {
      const ec2runner = {
        instanceId: 'WG113',
        org: 'owner',
        launchTime: moment(new Date())
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
        ghRunnerId: '33',
      };
      mocked(listRunners).mockResolvedValue([ec2runner]);
      mocked(listGithubRunnersOrg).mockResolvedValue([]);
      mocked(getRunnerOrg).mockResolvedValue(undefined);
      const mockedTerminateRunner = mocked(terminateRunner).mockImplementation(async () => {
        throw Error('error on terminateRunner');
      });

      await scaleDown();

      expect(mockedTerminateRunner).toBeCalled();
    });

    it('listGithubRunnersOrg returns [(matches, nonbusy)], removeGithubRunnerOrg is called', async () => {
      const ec2runner = {
        instanceId: 'WG113',
        org: 'owner',
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
          busy: false,
          labels: [],
        },
      ];
      mocked(listRunners).mockResolvedValue([ec2runner]);
      mocked(listGithubRunnersOrg).mockResolvedValue(matchRunner);
      const mockedGetRunner = mocked(getRunnerOrg).mockResolvedValue(undefined);
      const mockedRemoveGithubRunner = mocked(removeGithubRunnerOrg);

      await scaleDown();

      expect(mockedGetRunner).not.toBeCalled();
      expect(mockedRemoveGithubRunner).toBeCalledWith(ec2runner, matchRunner[0].id, 'owner', metrics);
    });

    it('listGithubRunnersOrg returns [(matches, nonbusy)], removeGithubRunnerOrg is NOT called', async () => {
      const ec2runner = {
        instanceId: 'WG113',
        org: 'owner',
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
      mocked(listRunners).mockResolvedValue([ec2runner]);
      mocked(listGithubRunnersOrg).mockResolvedValue(matchRunner);
      const mockedRemoveGithubRunner = mocked(removeGithubRunnerOrg);

      await scaleDown();

      expect(mockedRemoveGithubRunner).not.toBeCalled();
    });
  });
});

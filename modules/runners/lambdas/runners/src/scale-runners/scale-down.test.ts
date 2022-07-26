import {
  GhRunners,
  getRunner,
  listGithubRunners,
  listRunners,
  removeGithubRunner,
  resetRunnersCaches,
  terminateRunner,
} from './runners';

import { Config } from './config';
import { mocked } from 'ts-jest/utils';
import moment from 'moment';
import nock from 'nock';
import { scaleDown } from './scale-down';

jest.mock('./runners', () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any */
  ...(jest.requireActual('./runners') as any),
  getRunner: jest.fn(),
  listGithubRunners: jest.fn(),
  listRunners: jest.fn(),
  removeGithubRunner: jest.fn(),
  resetRunnersCaches: jest.fn(),
  terminateRunner: jest.fn(),
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  nock.disableNetConnect();
});

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
  });

  it('no runners are found', async () => {
    const mockedListRunners = mocked(listRunners).mockResolvedValue([]);
    const mockedResetRunnersCaches = mocked(resetRunnersCaches);

    await scaleDown();

    expect(mockedListRunners).toBeCalledWith({ environment: environment });
    expect(mockedResetRunnersCaches).not.toBeCalled();
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
    const mockedListGithubRunners = mocked(listGithubRunners);

    await scaleDown();

    expect(mockedResetRunnersCaches).toBeCalledTimes(1);
    expect(mockedListGithubRunners).not.toBeCalled();
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

  it('ec2runner with empty repo', async () => {
    mocked(listRunners).mockResolvedValue([
      {
        instanceId: 'WG113',
        launchTime: moment(new Date())
          .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
          .toDate(),
      },
    ]);
    const mockedResetRunnersCaches = mocked(resetRunnersCaches);
    const mockedListGithubRunners = mocked(listGithubRunners);

    await scaleDown();

    expect(mockedResetRunnersCaches).toBeCalledTimes(1);
    expect(mockedListGithubRunners).not.toBeCalled();
  });

  it('listGithubRunners returns [], getRunner returns undefined and terminateRunner with success', async () => {
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
    const mockedListGithubRunners = mocked(listGithubRunners).mockResolvedValue([]);
    const mockedGetRunner = mocked(getRunner).mockResolvedValue(undefined);
    const mockedTerminateRunner = mocked(terminateRunner);

    await scaleDown();

    expect(mockedListGithubRunners).toBeCalledWith(repo);
    expect(mockedGetRunner).toBeCalledWith(repo, ec2runner.ghRunnerId);
    expect(mockedTerminateRunner).toBeCalledWith(ec2runner);
  });

  it('listGithubRunners returns [], getRunner returns undefined and terminateRunner with raises', async () => {
    const ec2runner = {
      instanceId: 'WG113',
      repo: 'owner/repo',
      launchTime: moment(new Date())
        .subtract(minimumRunningTimeInMinutes + 5, 'minutes')
        .toDate(),
      ghRunnerId: '33',
    };
    mocked(listRunners).mockResolvedValue([ec2runner]);
    mocked(listGithubRunners).mockResolvedValue([]);
    mocked(getRunner).mockResolvedValue(undefined);
    const mockedTerminateRunner = mocked(terminateRunner).mockImplementation(async () => {
      throw Error('error on terminateRunner');
    });

    await scaleDown();

    expect(mockedTerminateRunner).toBeCalled();
  });

  it('listGithubRunners returns [(matches, nonbusy)], removeGithubRunner is called', async () => {
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
    mocked(listGithubRunners).mockResolvedValue(matchRunner);
    const mockedGetRunner = mocked(getRunner).mockResolvedValue(undefined);
    const mockedRemoveGithubRunner = mocked(removeGithubRunner);

    await scaleDown();

    expect(mockedGetRunner).not.toBeCalled();
    expect(mockedRemoveGithubRunner).toBeCalledWith(ec2runner, matchRunner[0].id, repo);
  });

  it('listGithubRunners returns [(matches, nonbusy)], removeGithubRunner is NOT called', async () => {
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
    mocked(listGithubRunners).mockResolvedValue(matchRunner);
    const mockedRemoveGithubRunner = mocked(removeGithubRunner);

    await scaleDown();

    expect(mockedRemoveGithubRunner).not.toBeCalled();
  });
});

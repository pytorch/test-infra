import { refreshChron, getGHRunnerType } from './refresh-chron';
import { listRunners, tryReuseRunner } from './runners';
import { getRunnerTypes } from './gh-runners';
import { Config } from './config';
import { getRepo } from './utils';

jest.mock('./runners');
jest.mock('./gh-runners');
jest.mock('./utils');
jest.mock('./metrics');

const mockedListRunners = listRunners as jest.Mock;
const mockedTryReuseRunner = tryReuseRunner as jest.Mock;
const mockedGetRunnerTypes = getRunnerTypes as jest.Mock;
const mockedGetRepo = getRepo as jest.Mock;

const dummyRunner = {
  instanceId: 'i-123456',
  ghRunnerId: '42',
  awsRegion: 'us-west-2',
  org: 'my-org',
  repo: 'my-org/my-repo',
  runnerType: 'c5.large',
  ephemeralRunnerFinished: undefined,
  ebsVolumeReplacementRequestTimestamp: undefined,
} as any;

describe('refreshChron', () => {
  jest.clearAllMocks();
  beforeEach(() => {
    (Config.Instance as any).environment = 'dev';
    (Config.Instance as any).enableOrganizationRunners = true;
    (Config.Instance as any).scaleConfigRepo = 'infra';
    (Config.Instance as any).minimumRunningTimeInMinutes = 10;
  });

  it('should call tryReuseRunner for eligible ephemeral runners', async () => {
    mockedListRunners.mockResolvedValue([dummyRunner]);
    mockedGetRepo.mockReturnValue({ owner: 'my-org', repo: 'infra' });
    mockedGetRunnerTypes.mockResolvedValue(
      new Map([
        [
          'c5.large',
          {
            runnerTypeName: 'c5.large',
            instance_type: 'c5.large',
            is_ephemeral: true,
            os: 'linux',
          },
        ],
      ]),
    );
    mockedTryReuseRunner.mockResolvedValue({});

    await refreshChron();

    expect(mockedTryReuseRunner).toHaveBeenCalled();
  });

  it('should skip non-ephemeral runners', async () => {
    mockedListRunners.mockResolvedValue([dummyRunner]);
    mockedGetRepo.mockReturnValue({ owner: 'my-org', repo: 'infra' });
    mockedGetRunnerTypes.mockResolvedValue(
      new Map([
        [
          'c5.large',
          {
            runnerTypeName: 'c5.large',
            instance_type: 'c5.large',
            is_ephemeral: false,
            os: 'linux',
          },
        ],
      ]),
    );

    await refreshChron();

    expect(mockedTryReuseRunner).not.toHaveBeenCalled();
  });

  it('should handle missing runnerType', async () => {
    mockedListRunners.mockResolvedValue([{ ...dummyRunner, runnerType: undefined }]);
    mockedGetRepo.mockReturnValue({ owner: 'my-org', repo: 'infra' });

    await refreshChron();

    expect(mockedTryReuseRunner).not.toHaveBeenCalled();
  });
});

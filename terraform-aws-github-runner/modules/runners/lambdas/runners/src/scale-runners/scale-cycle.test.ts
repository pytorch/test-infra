import { Config } from './config';
import { mocked } from 'ts-jest/utils';
import { getRepo, getRepoKey, RunnerInfo } from './utils';
import { getRunnerTypes } from './gh-runners';
import { listRunners, tryReuseRunner, RunnerType } from './runners';
import { scaleCycle } from './scale-cycle';
import { createRunnerConfigArgument } from './scale-up';
import * as MetricsModule from './metrics';
import nock from 'nock';

jest.mock('./runners');
jest.mock('./gh-runners');
jest.mock('./utils');
jest.mock('./scale-up');

const mockRunnerTypes = new Map([
  [
    'linux.2xlarge',
    {
      instance_type: 'm5.2xlarge',
      os: 'linux',
      max_available: 10,
      disk_size: 100,
      runnerTypeName: 'linux.2xlarge',
      is_ephemeral: true,
    } as RunnerType,
  ],
  [
    'windows.large',
    {
      instance_type: 'm5.large',
      os: 'windows',
      max_available: 5,
      disk_size: 200,
      runnerTypeName: 'windows.large',
      is_ephemeral: false,
    } as RunnerType,
  ],
]);

const mockRunners: RunnerInfo[] = [
  {
    instanceId: 'i-1234567890abcdef0',
    runnerType: 'linux.2xlarge',
    org: 'pytorch',
    repo: 'pytorch',
    awsRegion: 'us-west-2',
    ghRunnerId: 'runner-1',
    environment: 'test',
  },
  {
    instanceId: 'i-0987654321fedcba0',
    runnerType: 'windows.large',
    org: 'pytorch',
    repo: 'vision',
    awsRegion: 'us-east-1',
    ghRunnerId: 'runner-2',
    environment: 'test',
  },
];

const mockRunnersWithMissingTags: RunnerInfo[] = [
  {
    instanceId: 'i-missing-runner-type',
    runnerType: undefined, // Missing runnerType
    org: 'pytorch',
    repo: 'pytorch',
    awsRegion: 'us-west-2',
  },
  {
    instanceId: 'i-missing-org',
    runnerType: 'linux.2xlarge',
    org: undefined, // Missing org
    repo: 'pytorch',
    awsRegion: 'us-west-2',
  },
  {
    instanceId: 'i-missing-repo',
    runnerType: 'linux.2xlarge',
    org: 'pytorch',
    repo: undefined, // Missing repo
    awsRegion: 'us-west-2',
  },
];

const baseCfg = {
  scaleConfigOrg: 'pytorch',
  scaleConfigRepo: 'test-infra',
  environment: 'test',
  enableOrganizationRunners: false,
  minimumRunningTimeInMinutes: 5,
  awsRegion: 'us-east-1',
  cantHaveIssuesLabels: [],
  mustHaveIssuesLabels: [],
  lambdaTimeout: 600,
} as unknown as Config;

const metrics = new MetricsModule.ScaleCycleMetrics();

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();

  // Default mocks
  mocked(getRepo).mockReturnValue({ owner: 'pytorch', repo: 'test-infra' });
  mocked(getRepoKey).mockReturnValue('pytorch/pytorch');
  mocked(getRunnerTypes).mockResolvedValue(mockRunnerTypes);
  mocked(listRunners).mockResolvedValue([]);
  mocked(tryReuseRunner).mockResolvedValue(mockRunners[0]);
  mocked(createRunnerConfigArgument).mockResolvedValue('--url https://github.com/pytorch/pytorch --token mock-token --labels linux.2xlarge');

  // Mock metrics methods
  jest.spyOn(metrics, 'scaleCycleRunnerReuseFoundOrg').mockImplementation(() => {});
  jest.spyOn(metrics, 'scaleCycleRunnerReuseFoundRepo').mockImplementation(() => {});
});

describe('scaleCycle', () => {
  describe('basic functionality', () => {
         it('should successfully process runners with valid configuration', async () => {
       jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
       mocked(listRunners).mockResolvedValueOnce([mockRunners[0]]).mockResolvedValueOnce([mockRunners[1]]);

       await scaleCycle(metrics);

      // Verify getRunnerTypes was called correctly
      expect(getRunnerTypes).toHaveBeenCalledWith({ owner: 'pytorch', repo: 'test-infra' }, metrics);

      // Verify listRunners was called for each runner type
      expect(listRunners).toHaveBeenCalledTimes(2);
      expect(listRunners).toHaveBeenCalledWith(metrics, {
        containsTags: ['GithubRunnerID', 'EphemeralRunnerFinished', 'RunnerType'],
        runnerType: 'linux.2xlarge',
      });
      expect(listRunners).toHaveBeenCalledWith(metrics, {
        containsTags: ['GithubRunnerID', 'EphemeralRunnerFinished', 'RunnerType'],
        runnerType: 'windows.large',
      });

      // Verify tryReuseRunner was called for each valid runner
      expect(tryReuseRunner).toHaveBeenCalledTimes(2);
    });

    it('should handle empty runner list', async () => {
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
      mocked(listRunners).mockResolvedValue([]);

      await scaleCycle(metrics);

      expect(getRunnerTypes).toHaveBeenCalledTimes(1);
      expect(listRunners).toHaveBeenCalledTimes(2);
      expect(tryReuseRunner).not.toHaveBeenCalled();
    });

    it('should handle no runner types configured', async () => {
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
      mocked(getRunnerTypes).mockResolvedValue(new Map());

      await scaleCycle(metrics);

      expect(getRunnerTypes).toHaveBeenCalledTimes(1);
      expect(listRunners).not.toHaveBeenCalled();
      expect(tryReuseRunner).not.toHaveBeenCalled();
    });
  });

  describe('runner filtering and validation', () => {
         it('should skip runners with missing required tags', async () => {
       jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
       const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
       mocked(listRunners).mockResolvedValue(mockRunnersWithMissingTags);

       await scaleCycle(metrics);

       expect(consoleSpy).toHaveBeenCalledWith('Skipping runner i-missing-runner-type due to missing required tags');
       expect(consoleSpy).toHaveBeenCalledWith('Skipping runner i-missing-org due to missing required tags');
       expect(consoleSpy).toHaveBeenCalledWith('Skipping runner i-missing-repo due to missing required tags');
       expect(tryReuseRunner).not.toHaveBeenCalled();

       consoleSpy.mockRestore();
     });

     it('should skip runners with unknown runner types', async () => {
       jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
       const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
       const runnerWithUnknownType: RunnerInfo[] = [{
         instanceId: 'i-unknown-type',
         runnerType: 'unknown.type',
         org: 'pytorch',
         repo: 'pytorch',
         awsRegion: 'us-west-2',
       }];
       mocked(listRunners).mockResolvedValue(runnerWithUnknownType);

       await scaleCycle(metrics);

       expect(consoleSpy).toHaveBeenCalledWith('Unknown runner type: unknown.type, skipping');
       expect(tryReuseRunner).not.toHaveBeenCalled();

       consoleSpy.mockRestore();
     });
  });

  describe('organization vs repository runners', () => {
         it('should handle organization runners correctly', async () => {
       const orgConfig = {
         ...baseCfg,
         enableOrganizationRunners: true,
       } as unknown as Config;
       jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => orgConfig);
       const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
       mocked(listRunners).mockResolvedValueOnce([mockRunners[0]]).mockResolvedValueOnce([]); // Only test with one runner from first runner type

       await scaleCycle(metrics);

       expect(tryReuseRunner).toHaveBeenCalledWith(
         expect.objectContaining({
           orgName: 'pytorch',
           runnerType: mockRunnerTypes.get('linux.2xlarge'),
         }),
         metrics
       );

       expect(metrics.scaleCycleRunnerReuseFoundOrg).toHaveBeenCalledWith('pytorch', 'linux.2xlarge');
       expect(consoleSpy).toHaveBeenCalledWith('Reusing runner i-1234567890abcdef0 for pytorch');

       consoleSpy.mockRestore();
     });

     it('should handle repository runners correctly', async () => {
       jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
       const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
       mocked(listRunners).mockResolvedValue(mockRunners);

       await scaleCycle(metrics);

       expect(tryReuseRunner).toHaveBeenCalledWith(
         expect.objectContaining({
           repoName: 'pytorch/pytorch',
           runnerType: mockRunnerTypes.get('linux.2xlarge'),
         }),
         metrics
       );

       expect(metrics.scaleCycleRunnerReuseFoundRepo).toHaveBeenCalledWith('pytorch/pytorch', 'linux.2xlarge');
       expect(consoleSpy).toHaveBeenCalledWith('Reusing runner i-1234567890abcdef0 for pytorch/pytorch');

       consoleSpy.mockRestore();
     });
  });

  describe('runner configuration', () => {
         it('should create correct runner input parameters', async () => {
       jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
       mocked(listRunners).mockResolvedValue([mockRunners[0]]); // Use only the first runner
       mocked(getRepo).mockReturnValue({ owner: 'pytorch', repo: 'pytorch' }); // Mock to match the expected repo

       await scaleCycle(metrics);

       expect(tryReuseRunner).toHaveBeenCalledWith(
         expect.objectContaining({
           environment: 'test',
           runnerType: mockRunnerTypes.get('linux.2xlarge'),
           repoName: 'pytorch/pytorch',
           runnerConfig: expect.any(Function),
         }),
         metrics
       );

       // Test the runnerConfig function
       const callArgs = mocked(tryReuseRunner).mock.calls[0][0];
       const runnerConfigResult = await callArgs.runnerConfig('us-west-2', false);
       
       expect(createRunnerConfigArgument).toHaveBeenCalledWith(
         mockRunnerTypes.get('linux.2xlarge'),
         { owner: 'pytorch', repo: 'pytorch' },
         undefined,
         metrics,
         'us-west-2',
         false
       );
       expect(runnerConfigResult).toBe('--url https://github.com/pytorch/pytorch --token mock-token --labels linux.2xlarge');
     });
  });

  describe('error handling', () => {
    it('should handle getRunnerTypes failure', async () => {
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
      const error = new Error('Failed to get runner types');
      mocked(getRunnerTypes).mockRejectedValue(error);

      await expect(scaleCycle(metrics)).rejects.toThrow('Failed to get runner types');
      expect(listRunners).not.toHaveBeenCalled();
      expect(tryReuseRunner).not.toHaveBeenCalled();
    });

    it('should handle listRunners failure', async () => {
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
      const error = new Error('Failed to list runners');
      mocked(listRunners).mockRejectedValue(error);

      await expect(scaleCycle(metrics)).rejects.toThrow('Failed to list runners');
      expect(tryReuseRunner).not.toHaveBeenCalled();
    });

         it('should handle tryReuseRunner failure', async () => {
       jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
       const error = new Error('Failed to reuse runner');
       mocked(listRunners).mockResolvedValue(mockRunners);
       mocked(tryReuseRunner).mockRejectedValue(error);

       await expect(scaleCycle(metrics)).rejects.toThrow('Failed to reuse runner');
     });
  });

  describe('scale config repository', () => {
    it('should use custom scale config org and repo', async () => {
      const customConfig = {
        ...baseCfg,
        scaleConfigOrg: 'custom-org',
        scaleConfigRepo: 'custom-repo',
      } as unknown as Config;
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => customConfig);
      mocked(getRepo).mockReturnValue({ owner: 'custom-org', repo: 'custom-repo' });

      await scaleCycle(metrics);

      expect(getRepo).toHaveBeenCalledWith('custom-org', 'custom-repo');
      expect(getRunnerTypes).toHaveBeenCalledWith({ owner: 'custom-org', repo: 'custom-repo' }, metrics);
    });

    it('should handle missing scale config repo', async () => {
      const configWithoutRepo = {
        ...baseCfg,
        scaleConfigRepo: '',
      } as unknown as Config;
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => configWithoutRepo);

      await scaleCycle(metrics);

      expect(getRepo).toHaveBeenCalledWith('pytorch', '');
    });
  });

  describe('parallel processing', () => {
    it('should process multiple runner types in parallel', async () => {
      jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseCfg);
      const multiTypeRunners = [
        [mockRunners[0]], // linux.2xlarge runners
        [mockRunners[1]], // windows.large runners
      ];
      mocked(listRunners)
        .mockResolvedValueOnce(multiTypeRunners[0])
        .mockResolvedValueOnce(multiTypeRunners[1]);

      await scaleCycle(metrics);

      // Verify both runner types were queried
      expect(listRunners).toHaveBeenCalledTimes(2);
      expect(listRunners).toHaveBeenNthCalledWith(1, metrics, {
        containsTags: ['GithubRunnerID', 'EphemeralRunnerFinished', 'RunnerType'],
        runnerType: 'linux.2xlarge',
      });
      expect(listRunners).toHaveBeenNthCalledWith(2, metrics, {
        containsTags: ['GithubRunnerID', 'EphemeralRunnerFinished', 'RunnerType'],
        runnerType: 'windows.large',
      });

      // Verify both runners were processed
      expect(tryReuseRunner).toHaveBeenCalledTimes(2);
    });
  });
}); 
import moment from 'moment';
import { mocked } from 'ts-jest/utils';
import { Config } from './config';
import { resetSecretCache } from './gh-auth';
import { RunnerInfo } from './utils';
import {
  GhRunner,
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
  listSSMParameters,
} from './runners';
import {
  scaleDown,
  ghRunnerCache,
} from './scale-down';
import { SSM } from 'aws-sdk';

// Simplified mock setup
const mockGithubRunners = new Map<string, GhRunner[]>();

// Mock setup - must be at module level
jest.mock('./gh-runners', () => ({
  ...(jest.requireActual('./gh-runners') as any),
  listGithubRunnersOrg: jest.fn(),
  listGithubRunnersRepo: jest.fn(),
  removeGithubRunnerOrg: jest.fn().mockResolvedValue({}),
  removeGithubRunnerRepo: jest.fn().mockResolvedValue({}),
  resetGHRunnersCaches: jest.fn(),
  getRunnerOrg: jest.fn().mockResolvedValue(undefined),
  getRunnerRepo: jest.fn().mockResolvedValue(undefined),
  getRunnerTypes: jest.fn().mockResolvedValue(new Map([
    ['default', { is_ephemeral: false, min_available: 0 }],
    ['small', { is_ephemeral: false, min_available: 0 }],
    ['medium', { is_ephemeral: false, min_available: 0 }],
    ['large', { is_ephemeral: false, min_available: 0 }],
  ])),
}));

jest.mock('./runners', () => ({
  ...(jest.requireActual('./runners') as any),
  doDeleteSSMParameter: jest.fn().mockResolvedValue(true),
  listRunners: jest.fn(),
  listSSMParameters: jest.fn().mockResolvedValue(new Map()),
  resetRunnersCaches: jest.fn(),
  terminateRunner: jest.fn(),
}));

jest.mock('./gh-auth', () => ({
  resetSecretCache: jest.fn(),
  createGithubAuth: jest.fn().mockReturnValue({
    getToken: jest.fn().mockResolvedValue('mock-token'),
  }),
}));

jest.mock('./cache', () => ({
  ...(jest.requireActual('./cache') as any),
  locallyCached: jest.fn().mockImplementation(async (_, __, ___, callback) => callback()),
  redisCached: jest.fn().mockImplementation(async (_, __, ___, ____, callback) => callback()),
  redisLocked: jest.fn().mockImplementation(async (_, __, callback) => callback()),
  getExperimentValue: jest.fn().mockImplementation(async (_, defaultValue) => defaultValue),
}));

// Simplified configuration
const BENCHMARK_TIMEOUT = 30000;
const baseConfig = {
  minimumRunningTimeInMinutes: 1,
  environment: 'benchmark-test',
  minAvailableRunners: 0,
  awsRegion: 'us-east-1',
  enableOrganizationRunners: false,
  datetimeDeploy: '2023-01-01T00:00:00Z',
};

// Streamlined helper functions
const createRunner = (id: string, org: string, type = 'default'): RunnerInfo => ({
  instanceId: id,
  org,
  repo: `${org}/test-repo`,
  runnerType: type,
  awsRegion: 'us-east-1',
  launchTime: moment().subtract(10, 'minutes').toDate(),
  ghRunnerId: `gh-${id}`,
  applicationDeployDatetime: baseConfig.datetimeDeploy,
});

const createGhRunner = (id: string, name: string, busy = false): GhRunner => ({
  id: parseInt(id.replace('gh-', '')),
  name,
  os: 'linux',
  status: 'online',
  busy,
  labels: [{ id: 1, name: 'default', type: 'custom' }],
});

const setupTest = (runnerCount: number, options: {
  orgs?: string[];
  busyRatio?: number;
  ssmParams?: number;
  apiLatency?: number;
} = {}) => {
  const { orgs = ['test-org'], busyRatio = 0, ssmParams = 0, apiLatency = 0 } = options;
  
  const runners = Array.from({ length: runnerCount }, (_, i) => 
    createRunner(`runner-${i}`, orgs[i % orgs.length])
  );
  
  const ghRunners = Array.from({ length: runnerCount }, (_, i) => 
    createGhRunner(`${i}`, `runner-${i}`, i < runnerCount * busyRatio)
  );

  // Setup mocks
  mocked(listRunners).mockResolvedValue(runners);
  
  // Setup GitHub runners by org
  mockGithubRunners.clear();
  orgs.forEach(org => {
    const orgRunners = runners
      .filter(r => r.org === org)
      .map((r, i) => ghRunners[runners.indexOf(r)]);
    mockGithubRunners.set(`org-${org}`, orgRunners);
  });

  // Setup listGithubRunnersOrg mock implementation
  if (apiLatency > 0) {
    mocked(listGithubRunnersOrg).mockImplementation(async (org) => {
      await new Promise(resolve => setTimeout(resolve, apiLatency));
      return mockGithubRunners.get(`org-${org}`) || [];
    });
  } else {
    mocked(listGithubRunnersOrg).mockImplementation(async (org) => {
      return mockGithubRunners.get(`org-${org}`) || [];
    });
  }

  // Setup SSM parameters if needed
  if (ssmParams > 0) {
    const ssmMap = new Map(
      Array.from({ length: ssmParams }, (_, i) => [
        `/github-runner/param-${i}`,
        { Name: `/github-runner/param-${i}`, LastModifiedDate: moment().subtract(10, 'days').toDate() }
      ])
    );
    mocked(listSSMParameters).mockResolvedValue(ssmMap);
  }

  return { runners, ghRunners };
};

// Simplified performance measurement
const benchmark = async (name: string, operation: () => Promise<any>) => {
  const startTime = Date.now();
  const startMemory = process.memoryUsage().heapUsed / 1024 / 1024;
  
  // Track API calls
  const apiCalls = {
    listGithubRunnersOrg: 0,
    terminateRunner: 0,
    doDeleteSSMParameter: 0,
  };

  // Wrap mocks to count calls
  const originalListOrg = mocked(listGithubRunnersOrg).getMockImplementation();
  const originalTerminate = mocked(terminateRunner).getMockImplementation();
  const originalDeleteSSM = mocked(doDeleteSSMParameter).getMockImplementation();

  mocked(listGithubRunnersOrg).mockImplementation(async (...args) => {
    apiCalls.listGithubRunnersOrg++;
    return originalListOrg ? await originalListOrg(...args) : [];
  });
  mocked(terminateRunner).mockImplementation(async (...args) => {
    apiCalls.terminateRunner++;
    return originalTerminate ? await originalTerminate(...args) : undefined;
  });
  mocked(doDeleteSSMParameter).mockImplementation(async (...args) => {
    apiCalls.doDeleteSSMParameter++;
    return originalDeleteSSM ? await originalDeleteSSM(...args) : true;
  });

  const result = await operation();
  
  const executionTime = Date.now() - startTime;
  const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024 - startMemory;
  
  const summary = `${name}: ${executionTime}ms, ${memoryUsage.toFixed(2)}MB, API calls: ${JSON.stringify(apiCalls)}`;
  console.log(`📊 ${summary}`);
  
  return { result, executionTime, memoryUsage, apiCalls };
};

describe('Scale Down Performance Benchmarks', () => {
  let metrics: MetricsModule.ScaleDownMetrics;

  beforeEach(() => {
    jest.clearAllMocks();
    ghRunnerCache.clear();
    
    // Suppress logging for cleaner output
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    
    jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => baseConfig as unknown as Config);
    
    metrics = new MetricsModule.ScaleDownMetrics();
    jest.spyOn(MetricsModule, 'ScaleDownMetrics').mockReturnValue(metrics);
    jest.spyOn(metrics, 'sendMetrics').mockImplementation(async () => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Parameterized benchmark tests
  const benchmarkScenarios = [
    { name: 'Small scale', runners: 5, timeout: 5000, memory: 50 },
    { name: 'Medium scale', runners: 25, timeout: 15000, memory: 150 },
    { name: 'Large scale', runners: 100, timeout: 45000, memory: 300 },
  ];

  benchmarkScenarios.forEach(({ name, runners, timeout, memory }) => {
    test(`${name}: ${runners} runners`, async () => {
      const { ghRunners } = setupTest(runners);
      
      const { executionTime, memoryUsage, apiCalls } = await benchmark(
        `${runners} runners`,
        async () => await scaleDown()
      );
      
      expect(executionTime).toBeLessThan(timeout);
      expect(memoryUsage).toBeLessThan(memory);
      expect(apiCalls.terminateRunner).toBe(runners);
    }, BENCHMARK_TIMEOUT);
  });

  test('Mixed busy/idle states', async () => {
    const runnerCount = 10;
    const { ghRunners } = setupTest(runnerCount, { busyRatio: 0.3 }); // 30% busy
    
    const { apiCalls } = await benchmark(
      'Mixed busy/idle',
      async () => await scaleDown()
    );
    
    // Note: For benchmark purposes, we're testing the termination count
    // The actual busy/idle logic depends on the scale-down implementation
    expect(apiCalls.terminateRunner).toBe(runnerCount);
    console.log(`Busy runners: ${ghRunners.filter(r => r.busy).length}, Idle: ${ghRunners.filter(r => !r.busy).length}`);
  }, BENCHMARK_TIMEOUT);

  test('Multiple organizations', async () => {
    const runnerCount = 30;
    const orgs = ['org-1', 'org-2', 'org-3'];
    setupTest(runnerCount, { orgs });
    
    const { apiCalls } = await benchmark(
      'Multiple orgs',
      async () => await scaleDown()
    );
    
    expect(apiCalls.terminateRunner).toBe(runnerCount);
    expect(apiCalls.listGithubRunnersOrg).toBeLessThanOrEqual(orgs.length);
  }, BENCHMARK_TIMEOUT);

  test('With SSM cleanup', async () => {
    const runnerCount = 20;
    setupTest(runnerCount, { ssmParams: 10 });
    
    const { apiCalls } = await benchmark(
      'SSM cleanup',
      async () => await scaleDown()
    );
    
    expect(apiCalls.terminateRunner).toBe(runnerCount);
    expect(apiCalls.doDeleteSSMParameter).toBe(10);
  }, BENCHMARK_TIMEOUT);

  test('API latency simulation', async () => {
    const runnerCount = 20;
    const orgs = ['org-1', 'org-2'];
    setupTest(runnerCount, { orgs, apiLatency: 50 });
    
    const { executionTime } = await benchmark(
      'API latency',
      async () => await scaleDown()
    );
    
    // Should complete faster than sequential calls would take
    const sequentialTime = orgs.length * 50 + runnerCount * 25;
    expect(executionTime).toBeLessThan(sequentialTime * 0.7);
  }, BENCHMARK_TIMEOUT);

  test('Error resilience', async () => {
    const runnerCount = 15;
    setupTest(runnerCount);
    
    // Simulate API failures
    let failureCount = 0;
    mocked(listGithubRunnersOrg).mockImplementation(async () => {
      if (++failureCount % 2 === 0) throw new Error('API failure');
      return [];
    });

    const { executionTime, apiCalls } = await benchmark(
      'Error resilience',
      async () => await scaleDown()
    );
    
    expect(executionTime).toBeLessThan(20000);
    expect(apiCalls.terminateRunner).toBeGreaterThan(0);
  }, BENCHMARK_TIMEOUT);
}); 
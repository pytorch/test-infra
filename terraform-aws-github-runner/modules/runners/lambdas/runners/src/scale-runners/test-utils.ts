import { RunnerType } from './runners';
import { RunnerInfo } from './utils';

export const TEST_RUNNER_TYPE_1 = 'test-type-1';
export const TEST_RUNNER_TYPE_1_NAME = 'test-type-1-name';

export function getFakeRunnerType() {
  return {
    name: TEST_RUNNER_TYPE_1_NAME,
    disk_size: 0,
    instance_type: 'instance-type-1',
    is_ephemeral: true,
    os: 'test-os',
    runnerTypeName: TEST_RUNNER_TYPE_1,
  };
}

export function getDefautltFakeRunnerTypes(): Map<string, RunnerType> {
  return new Map([[TEST_RUNNER_TYPE_1, getFakeRunnerType()]]);
}
export function getFakeRunnerInfoRepo(): RunnerInfo {
  return {
    applicationDeployDatetime: '2025-05-31T12:34:56Z',
    awsRegion: 'us-west-1',
    az: 'us-west-1',
    ebsVolumeReplacementRequestTimestamp: Math.floor(Date.now() / 1000) - 300,
    environment: 'test-runner-info-env-repo',
    ephemeralRunnerFinished: Math.floor(Date.now() / 1000) - 120,
    ghRunnerId: '5678',
    instanceId: 'i-test-id',
    instanceManagement: 'ssm',
    launchTime: new Date('2025-05-31T00:00:00Z'),
    repositoryOwner: 'example-org',
    repositoryName: 'example-repo',
    org: undefined,
    repo: 'example-org/example-repo',
    runnerType: TEST_RUNNER_TYPE_1,
    ephemeralRunnerStage: 'ReplaceEBSVolume',
  };
}

export function getFakeRunnerInfoOrg(): RunnerInfo {
  return {
    applicationDeployDatetime: '2025-05-31T12:34:56Z',
    awsRegion: 'us-west-1',
    az: 'us-west-1',
    ebsVolumeReplacementRequestTimestamp: Math.floor(Date.now() / 1000) - 300,
    environment: 'test-runner-info-env-org',
    ephemeralRunnerFinished: Math.floor(Date.now() / 1000) - 120,
    ghRunnerId: '5678',
    instanceId: 'i-test-id',
    instanceManagement: 'ssm',
    launchTime: new Date('2025-05-31T00:00:00Z'),
    repositoryOwner: 'example-org',
    repositoryName: 'example-repo',
    org: 'example-org',
    runnerType: TEST_RUNNER_TYPE_1,
    ephemeralRunnerStage: 'ReplaceEBSVolume',
  };
}

export class FakeRunnerTypes {
  private defaultMap: Map<string, RunnerType>;
  private map: Map<string, RunnerType>;

  constructor(defaults?: Map<string, RunnerType>) {
    this.defaultMap = defaults ?? getDefautltFakeRunnerTypes();
    this.map = new Map(this.defaultMap);
  }

  get(): Map<string, RunnerType> {
    return this.map;
  }

  getItem(key: string): RunnerType | undefined {
    const item = this.map.get(key);
    return item ? structuredClone(item) : undefined;
  }

  set(key: string, value: RunnerType): void {
    this.map.set(key, value);
  }

  reset(): void {
    this.map = getDefautltFakeRunnerTypes();
  }
}

export async function expectToThrow<T extends Error = Error>(
  fn: () => Promise<unknown>,
  errorClass: new (...args: any[]) => T = Error as unknown as new (...args: any[]) => T,
  messageMatch?: RegExp | string,
): Promise<void> {
  let thrown: unknown;

  try {
    await fn();
  } catch (e) {
    thrown = e;
  }

  expect(thrown).toBeInstanceOf(errorClass);

  if (messageMatch) {
    const message = (thrown as Error).message;
    if (messageMatch instanceof RegExp) {
      expect(message).toMatch(messageMatch);
    } else {
      expect(message).toContain(messageMatch);
    }
  }
}

import {
  locallyCached,
  redisCached,
  clearLocalCache,
  shutdownRedisPool,
  redisClearCacheKeyPattern,
  getExperimentValue,
  getJoinedStressTestExperiment,
} from './cache';
import { mocked } from 'ts-jest/utils';
import { v4 as uuidv4 } from 'uuid';
import nock from 'nock';
import { RedisClientType, createClient } from 'redis';
import { Config } from './config';

jest.mock('uuid', () => ({
  v4: jest.fn(),
}));

const mockedRedisClient = {
  get: jest.fn(),
  set: jest.fn(),
  sendCommand: jest.fn(),
  eval: jest.fn(),
  on: jest.fn(),
  connect: jest.fn(),
  scanIterator: jest.fn(),
};

function produceMockedRedis(): RedisClientType {
  mockedRedisClient.eval.mockResolvedValue('OK');
  mockedRedisClient.set.mockResolvedValue('OK');
  return mockedRedisClient as unknown as RedisClientType;
}

const config = {
  datetimeDeploy: '20230310191716',
  environment: 'gh-ci',
};

jest.mock('redis');

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.resetAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();

  mocked(createClient).mockImplementation(produceMockedRedis);

  jest.spyOn(Config, 'Instance', 'get').mockImplementation(() => config as unknown as Config);
});

describe('locallyCached', () => {
  beforeEach(() => {
    clearLocalCache();
  });

  it('clear cache, nothing local, calls function', async () => {
    const returnValue = 'return value A';
    const fn = jest.fn().mockResolvedValue(returnValue);

    expect(await locallyCached('namespace', 'key', 0.1, fn)).toEqual(returnValue);
    expect(fn).toBeCalledTimes(1);
  });

  it('clear cache, nothing local, calls function, throws exception', async () => {
    const rejectMsg = 'the reject msg';
    const fn = jest.fn().mockRejectedValue(new Error(rejectMsg));

    await expect(locallyCached('namespace', 'key', 0.1, fn)).rejects.toThrow(rejectMsg);
    expect(fn).toBeCalledTimes(1);
  });

  it('makes sure different namespaces are respected', async () => {
    const returnValue1 = 'return value A - 1';
    const returnValue2 = 'return value A - 2';
    const fn1 = jest.fn().mockResolvedValue(returnValue1);
    const fn2 = jest.fn().mockResolvedValue(returnValue2);

    expect(await locallyCached('namespace 1', 'key', 0.1, fn1)).toEqual(returnValue1);
    expect(await locallyCached('namespace 1', 'key', 0.1, fn1)).toEqual(returnValue1);
    expect(await locallyCached('namespace 2', 'key', 0.1, fn2)).toEqual(returnValue2);
    expect(await locallyCached('namespace 2', 'key', 0.1, fn2)).toEqual(returnValue2);
    expect(fn1).toBeCalledTimes(1);
    expect(fn2).toBeCalledTimes(1);
  });

  it('makes sure different keys are respected', async () => {
    const returnValue1 = 'return value A - 1';
    const returnValue2 = 'return value A - 2';
    const fn1 = jest.fn().mockResolvedValue(returnValue1);
    const fn2 = jest.fn().mockResolvedValue(returnValue2);

    expect(await locallyCached('namespace', 'key 1', 0.1, fn1)).toEqual(returnValue1);
    expect(await locallyCached('namespace', 'key 1', 0.1, fn1)).toEqual(returnValue1);
    expect(await locallyCached('namespace', 'key 2', 0.1, fn2)).toEqual(returnValue2);
    expect(await locallyCached('namespace', 'key 2', 0.1, fn2)).toEqual(returnValue2);
    expect(fn1).toBeCalledTimes(1);
    expect(fn2).toBeCalledTimes(1);
  });

  it('clear cache, calls function, gets from local', async () => {
    const returnValue = 'return value B';
    const fn = jest.fn().mockResolvedValue(returnValue);

    expect(await locallyCached('namespace', 'key', 0.1, fn)).toEqual(returnValue);
    expect(await locallyCached('namespace', 'key', 0.1, fn)).toEqual(returnValue);
    expect(fn).toBeCalledTimes(1);
  });

  it('clear cache, calls function, local expires, call function', async () => {
    const returnValue = 'return value C';
    const fn = jest.fn().mockResolvedValue(returnValue);

    expect(await locallyCached('namespace', 'key', 0.1, fn)).toEqual(returnValue);
    expect(await locallyCached('namespace', 'key', 0.1, fn)).toEqual(returnValue);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await locallyCached('namespace', 'key', 0.1, fn)).toEqual(returnValue);
    expect(await locallyCached('namespace', 'key', 0.1, fn)).toEqual(returnValue);
    expect(fn).toBeCalledTimes(2);
  });

  it('clear cache, make two concurrent asks for cache, calls only once', async () => {
    const returnValue = 'return value D';
    const fn = jest.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return returnValue;
    });

    const req1 = locallyCached('namespace', 'key', 0.5, fn);
    const req2 = locallyCached('namespace', 'key', 0.5, fn);

    expect(await req1).toEqual(returnValue);
    expect(await req2).toEqual(returnValue);

    expect(fn).toBeCalledTimes(1);
  });
});

describe('experiment functions', () => {
  beforeEach(async () => {
    await shutdownRedisPool();
    clearLocalCache();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await shutdownRedisPool();
  });

  describe('getExperimentValue', () => {
    it('returns the value from redis when it exists', async () => {
      const experimentKey = 'test-experiment';
      const experimentValue = '42';
      const defaultValue = 10;

      mockedRedisClient.get.mockResolvedValueOnce(experimentValue);

      const result = await getExperimentValue(experimentKey, defaultValue);

      expect(result).toBe(42);
      expect(mockedRedisClient.get).toBeCalledTimes(1);
      expect(mockedRedisClient.get).toBeCalledWith('gh-ci.EXPERIMENT.test-experiment');
    });

    it('returns default value when key does not exist', async () => {
      const experimentKey = 'missing-experiment';
      const defaultValue = 10;

      mockedRedisClient.get.mockResolvedValueOnce(null);

      const result = await getExperimentValue(experimentKey, defaultValue);

      expect(result).toBe(defaultValue);
      expect(mockedRedisClient.get).toBeCalledTimes(1);
      expect(mockedRedisClient.get).toBeCalledWith('gh-ci.EXPERIMENT.missing-experiment');
    });

    it('returns default value when redis throws an error', async () => {
      const experimentKey = 'error-experiment';
      const defaultValue = 10;

      mockedRedisClient.get.mockRejectedValueOnce(new Error('Redis error'));

      const result = await getExperimentValue(experimentKey, defaultValue);

      expect(result).toBe(defaultValue);
      expect(mockedRedisClient.get).toBeCalledTimes(1);
    });

    it('returns default value when value is not a valid number', async () => {
      const experimentKey = 'invalid-experiment';
      const defaultValue = 10;

      mockedRedisClient.get.mockResolvedValueOnce('not-a-number');

      const result = await getExperimentValue(experimentKey, defaultValue);

      expect(result).toBe(defaultValue);
      expect(mockedRedisClient.get).toBeCalledTimes(1);
    });
  });

  describe('getJoinedStressTestExperiment', () => {
    it('returns false when RUNNER_NAME_SUFFIX is not set', async () => {
      mockedRedisClient.get.mockResolvedValueOnce(null);

      const result = await getJoinedStressTestExperiment('TEST_EXPERIMENT', 'runner-name');

      expect(result).toBe(false);
      expect(mockedRedisClient.get).toBeCalledTimes(1);
      expect(mockedRedisClient.get).toBeCalledWith('gh-ci.EXPERIMENT.RUNNER_NAME_SUFFIX');
    });

    it('returns false when runner name does not match suffix', async () => {
      mockedRedisClient.get.mockResolvedValueOnce('-suffix');

      const result = await getJoinedStressTestExperiment('TEST_EXPERIMENT', 'runner-name-without-match');

      expect(result).toBe(false);
      expect(mockedRedisClient.get).toBeCalledTimes(1);
      expect(mockedRedisClient.get).toBeCalledWith('gh-ci.EXPERIMENT.RUNNER_NAME_SUFFIX');
    });

    it('returns false when probability is less than random value', async () => {
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.6);

      mockedRedisClient.get.mockResolvedValueOnce('-suffix');
      mockedRedisClient.get.mockResolvedValueOnce('50');

      const result = await getJoinedStressTestExperiment('TEST_EXPERIMENT', 'runner-name-suffix');

      expect(result).toBe(false);
      expect(mockedRedisClient.get).toBeCalledTimes(2);
      expect(mockedRedisClient.get).toHaveBeenNthCalledWith(1, 'gh-ci.EXPERIMENT.RUNNER_NAME_SUFFIX');
      expect(mockedRedisClient.get).toHaveBeenNthCalledWith(2, 'gh-ci.EXPERIMENT.TEST_EXPERIMENT');
    });

    it('returns true when probability is greater than random value', async () => {
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.4);

      mockedRedisClient.get.mockResolvedValueOnce('-suffix');
      mockedRedisClient.get.mockResolvedValueOnce('50');

      const result = await getJoinedStressTestExperiment('TEST_EXPERIMENT', 'runner-name-suffix');

      expect(result).toBe(true);
      expect(mockedRedisClient.get).toBeCalledTimes(2);
      expect(mockedRedisClient.get).toHaveBeenNthCalledWith(1, 'gh-ci.EXPERIMENT.RUNNER_NAME_SUFFIX');
      expect(mockedRedisClient.get).toHaveBeenNthCalledWith(2, 'gh-ci.EXPERIMENT.TEST_EXPERIMENT');
    });

    it('returns false when experiment value is zero', async () => {
      mockedRedisClient.get.mockResolvedValueOnce('-suffix');
      mockedRedisClient.get.mockResolvedValueOnce('0');

      const result = await getJoinedStressTestExperiment('TEST_EXPERIMENT', 'runner-name-suffix');

      expect(result).toBe(false);
      expect(mockedRedisClient.get).toBeCalledTimes(2);
      expect(mockedRedisClient.get).toHaveBeenNthCalledWith(1, 'gh-ci.EXPERIMENT.RUNNER_NAME_SUFFIX');
      expect(mockedRedisClient.get).toHaveBeenNthCalledWith(2, 'gh-ci.EXPERIMENT.TEST_EXPERIMENT');
    });

    it('returns true when experiment value is 100', async () => {
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.99);

      mockedRedisClient.get.mockResolvedValueOnce('-suffix');
      mockedRedisClient.get.mockResolvedValueOnce('100');

      const result = await getJoinedStressTestExperiment('TEST_EXPERIMENT', 'runner-name-suffix');

      expect(result).toBe(true);
      expect(mockedRedisClient.get).toBeCalledTimes(2);
      expect(mockedRedisClient.get).toHaveBeenNthCalledWith(1, 'gh-ci.EXPERIMENT.RUNNER_NAME_SUFFIX');
      expect(mockedRedisClient.get).toHaveBeenNthCalledWith(2, 'gh-ci.EXPERIMENT.TEST_EXPERIMENT');
    });

    it('returns false when experiment value is not a valid number', async () => {
      mockedRedisClient.get.mockResolvedValueOnce('-suffix');
      mockedRedisClient.get.mockResolvedValueOnce('not-a-number');

      const result = await getJoinedStressTestExperiment('TEST_EXPERIMENT', 'runner-name-suffix');

      expect(result).toBe(false);
      expect(mockedRedisClient.get).toBeCalledTimes(2);
      expect(mockedRedisClient.get).toHaveBeenNthCalledWith(1, 'gh-ci.EXPERIMENT.RUNNER_NAME_SUFFIX');
      expect(mockedRedisClient.get).toHaveBeenNthCalledWith(2, 'gh-ci.EXPERIMENT.TEST_EXPERIMENT');
    });

    it('returns false when experiment query throws an error', async () => {
      mockedRedisClient.get.mockResolvedValueOnce('-suffix');
      mockedRedisClient.get.mockRejectedValueOnce(new Error('Redis error'));

      const result = await getJoinedStressTestExperiment('TEST_EXPERIMENT', 'runner-name-suffix');

      expect(result).toBe(false);
      expect(mockedRedisClient.get).toBeCalledTimes(2);
      expect(mockedRedisClient.get).toHaveBeenNthCalledWith(1, 'gh-ci.EXPERIMENT.RUNNER_NAME_SUFFIX');
    });
  });
});

describe('redisCached', () => {
  beforeEach(async () => {
    await shutdownRedisPool();
    clearLocalCache();
  });

  it('nothing local or remote, acquires lock first time, calls function, throws exception', async () => {
    const rejectMsg = 'the reject msg';
    const fn = jest.fn().mockRejectedValue(new Error(rejectMsg));
    const uuid = 'AGDGADUWG113';

    jest.spyOn(global.Date, 'now').mockImplementationOnce(() => new Date('2019-06-29T11:01:58.135Z').valueOf());
    mockedRedisClient.get.mockResolvedValueOnce(undefined);
    (uuidv4 as jest.Mock).mockReturnValue(uuid);
    mockedRedisClient.sendCommand.mockResolvedValueOnce('OK');
    mockedRedisClient.sendCommand.mockResolvedValueOnce('OK');

    await expect(redisCached('namespace', 'key', 0.5, 1.0, fn)).rejects.toThrow(rejectMsg);

    expect(mockedRedisClient.get).toBeCalledTimes(1);
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.20230310191716.CACHE.namespace-key');
    expect(mockedRedisClient.sendCommand).toBeCalledTimes(1);
    expect(mockedRedisClient.sendCommand).toHaveBeenCalledWith([
      'SET',
      'gh-ci.20230310191716.LOCK.namespace-key',
      uuid,
      'NX',
      'PX',
      '20000',
    ]);
    expect(mockedRedisClient.eval).toBeCalledTimes(1);
    expect(mockedRedisClient.eval).toBeCalledWith(
      `if redis.call("get","gh-ci.20230310191716.LOCK.namespace-key") == "${uuid}" then ` +
        `return redis.call("del","gh-ci.20230310191716.LOCK.namespace-key") else return 0 end`,
    );
    expect(mockedRedisClient.set).toBeCalledTimes(0);
    expect(fn).toBeCalledTimes(1);
  });

  it('nothing local or remote, acquires lock first time, calls function', async () => {
    const returnValue = 'TheReturn VALUE A';
    const uuid = 'AGDGADUWG113';
    const fn = jest.fn().mockResolvedValue(returnValue);

    jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2019-06-29T11:01:58.135Z').valueOf());
    mockedRedisClient.get.mockResolvedValueOnce(undefined);
    (uuidv4 as jest.Mock).mockReturnValue(uuid);
    mockedRedisClient.sendCommand.mockResolvedValueOnce('OK');
    mockedRedisClient.set.mockResolvedValueOnce('OK');
    mockedRedisClient.sendCommand.mockResolvedValueOnce('OK');

    expect(await redisCached('namespace', 'key', 0.5, 1.0, fn)).toEqual(returnValue);

    expect(mockedRedisClient.get).toBeCalledTimes(1);
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.20230310191716.CACHE.namespace-key');
    expect(mockedRedisClient.sendCommand).toBeCalledTimes(1);
    expect(mockedRedisClient.sendCommand).toHaveBeenCalledWith([
      'SET',
      'gh-ci.20230310191716.LOCK.namespace-key',
      uuid,
      'NX',
      'PX',
      '20000',
    ]);
    expect(mockedRedisClient.eval).toBeCalledTimes(1);
    expect(mockedRedisClient.eval).toBeCalledWith(
      `if redis.call("get","gh-ci.20230310191716.LOCK.namespace-key") == "${uuid}" then ` +
        `return redis.call("del","gh-ci.20230310191716.LOCK.namespace-key") else return 0 end`,
    );
    expect(mockedRedisClient.set).toBeCalledTimes(1);
    expect(mockedRedisClient.set).toBeCalledWith(
      'gh-ci.20230310191716.CACHE.namespace-key',
      `{"data":"${returnValue}","ttl":1561806118.635,"version":"20230310191716"}`,
      { EX: 1 },
    );
    expect(fn).toBeCalledTimes(1);
  });

  it('nothing local, data on remote, less than ttl', async () => {
    const returnValue = 'TheReturn VALUE A';
    const fn = jest.fn().mockResolvedValue(returnValue);

    jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2019-06-29T11:01:58.135Z').valueOf());
    mockedRedisClient.get.mockResolvedValueOnce(
      `{"data":"${returnValue}","ttl":1561806218.635,"version":"20230310191716"}`,
    );

    expect(await redisCached('namespace', 'key', 0.5, 1.0, fn)).toEqual(returnValue);

    expect(mockedRedisClient.get).toBeCalledTimes(1);
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.20230310191716.CACHE.namespace-key');
    expect(mockedRedisClient.set).toBeCalledTimes(0);
    expect(mockedRedisClient.sendCommand).toBeCalledTimes(0);
    expect(mockedRedisClient.eval).toBeCalledTimes(0);
    expect(fn).toBeCalledTimes(0);
  });

  it('nothing on local, data on remote, above ttl and decide to not expire', async () => {
    const returnValue = 'TheReturn VALUE A';
    const fn = jest.fn().mockResolvedValue(returnValue);

    jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2019-06-29T11:01:58.135Z').valueOf());
    jest.spyOn(global.Math, 'random').mockReturnValueOnce(1.0);
    mockedRedisClient.get.mockResolvedValueOnce(
      `{"data":"${returnValue}","ttl":1561806117.9,"version":"20230310191716"}`,
    );

    expect(await redisCached('namespace', 'key', 0.5, 1.0, fn)).toEqual(returnValue);

    expect(mockedRedisClient.get).toBeCalledTimes(1);
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.20230310191716.CACHE.namespace-key');
    expect(mockedRedisClient.set).toBeCalledTimes(0);
    expect(mockedRedisClient.sendCommand).toBeCalledTimes(0);
    expect(mockedRedisClient.eval).toBeCalledTimes(0);
    expect(fn).toBeCalledTimes(0);
  });

  it('nothing on local, data on remote, above ttl & decide to expire', async () => {
    const returnValue = 'TheReturn VALUE A';
    const uuid = 'AGDGADUWG113';
    const fn = jest.fn().mockResolvedValue(returnValue);

    jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.1);

    mockedRedisClient.get.mockResolvedValueOnce(
      `{"data":"${returnValue}","ttl":1561806117.9,"version":"20230310191716"}`,
    );
    (uuidv4 as jest.Mock).mockReturnValue(uuid);
    mockedRedisClient.sendCommand.mockResolvedValueOnce('OK');
    mockedRedisClient.set.mockResolvedValueOnce('OK');
    mockedRedisClient.sendCommand.mockResolvedValueOnce('OK');

    expect(await redisCached('namespace', 'key', 0.5, 1.0, fn)).toEqual(returnValue);

    expect(mockedRedisClient.get).toBeCalledTimes(1);
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.20230310191716.CACHE.namespace-key');
    expect(mockedRedisClient.sendCommand).toBeCalledTimes(1);
    expect(mockedRedisClient.sendCommand).toHaveBeenCalledWith([
      'SET',
      'gh-ci.20230310191716.LOCK.namespace-key',
      uuid,
      'NX',
      'PX',
      '20000',
    ]);
    expect(mockedRedisClient.eval).toBeCalledTimes(1);
    expect(mockedRedisClient.eval).toBeCalledWith(
      `if redis.call("get","gh-ci.20230310191716.LOCK.namespace-key") == "${uuid}" then ` +
        `return redis.call("del","gh-ci.20230310191716.LOCK.namespace-key") else return 0 end`,
    );
    expect(mockedRedisClient.set).toBeCalledTimes(1);
    expect(fn).toBeCalledTimes(1);
  });

  it('nothing on local and remote, but cant acquire lock, after retrying gets data from remote', async () => {
    const returnValue = 'TheReturn VALUE A';
    const uuid = 'AGDGADUWG113';
    const fn = jest.fn().mockResolvedValue(returnValue);

    jest.spyOn(global.Date, 'now').mockImplementation(() => new Date('2019-06-29T11:01:58.135Z').valueOf());
    mockedRedisClient.get.mockResolvedValueOnce(undefined);
    mockedRedisClient.get.mockResolvedValueOnce(undefined);
    mockedRedisClient.get.mockResolvedValueOnce(undefined);
    mockedRedisClient.get.mockResolvedValueOnce('asdfasdfasdf');
    mockedRedisClient.get.mockResolvedValueOnce(
      `{"data":"${returnValue}","ttl":1561806218.635,"version":"20230310191716"}`,
    );

    (uuidv4 as jest.Mock).mockReturnValue(uuid);

    mockedRedisClient.sendCommand.mockResolvedValueOnce(undefined);

    expect(await redisCached('namespace', 'key', 0.5, 1.0, fn)).toEqual(returnValue);

    expect(mockedRedisClient.get).toBeCalledTimes(5);
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.20230310191716.CACHE.namespace-key');
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.20230310191716.LOCK.namespace-key');
    expect(fn).toBeCalledTimes(0);
  });

  it('redisClearCacheKeyPattern', async () => {
    const keys = [
      'gh-ci.20230310191716.CACHE.namespace-key$agdgaduwg113',
      'gh-ci.20230310191716.CACHE.namespace-key$xismiton',
    ];
    mockedRedisClient.scanIterator.mockImplementation(async function* () {
      for (const key of keys) {
        yield key;
      }
    });

    expect(await redisClearCacheKeyPattern('namespace', 'key'));

    expect(mockedRedisClient.scanIterator).toBeCalledTimes(1);
    expect(mockedRedisClient.sendCommand).toBeCalledTimes(2);
    expect(mockedRedisClient.sendCommand).toBeCalledWith(['UNLINK', keys[0]]);
    expect(mockedRedisClient.sendCommand).toBeCalledWith(['UNLINK', keys[1]]);
  });
});

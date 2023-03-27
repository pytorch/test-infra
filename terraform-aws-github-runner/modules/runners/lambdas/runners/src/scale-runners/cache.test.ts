import { locallyCached, redisCached, clearLocalCache, shutdownRedisPool } from './cache';
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
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.CACHE.namespace-key');
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
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.CACHE.namespace-key');
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
      'gh-ci.CACHE.namespace-key',
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
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.CACHE.namespace-key');
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
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.CACHE.namespace-key');
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
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.CACHE.namespace-key');
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
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.CACHE.namespace-key');
    expect(mockedRedisClient.get).toBeCalledWith('gh-ci.20230310191716.LOCK.namespace-key');
    expect(fn).toBeCalledTimes(0);
  });
});

import { locallyCached, redisCached, clearLocalCache, shutdownRedisPool } from './cache';
import { mocked } from 'ts-jest/utils';
import { v4 as uuidv4 } from 'uuid';
import nock from 'nock';
import redisPoolFactory from 'redis-connection-pool';
import { RedisConnectionPool } from 'redis-connection-pool';
// import { Mock } from 'jest';

jest.mock('uuid', () => ({
  v4: jest.fn(),
}));

const mockedRedisPool = {
  get: jest.fn(),
  set: jest.fn(),
  sendCommand: jest.fn(),
};

jest.mock('redis-connection-pool');

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();

  mocked(redisPoolFactory).mockResolvedValue(mockedRedisPool as unknown as RedisConnectionPool);
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
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(await locallyCached('namespace', 'key', 0.1, fn)).toEqual(returnValue);
    expect(await locallyCached('namespace', 'key', 0.1, fn)).toEqual(returnValue);
    expect(fn).toBeCalledTimes(2);
  });

  it('clear cache, make two concurrent asks for cache, calls only once', async () => {
    const returnValue = 'return value D';
    const fn = jest.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
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

    jest
      .spyOn(global.Date, 'now')
      .mockImplementationOnce(() =>
        new Date('2019-06-29T11:01:58.135Z').valueOf()
      );
    mockedRedisPool.get.mockResolvedValueOnce(undefined);
    (uuidv4 as jest.Mock).mockReturnValue(uuid);
    mockedRedisPool.sendCommand.mockResolvedValueOnce('OK');
    mockedRedisPool.sendCommand.mockResolvedValueOnce('OK');

    await expect(redisCached('namespace', 'key', 0.5, 1.0, fn)).rejects.toThrow(rejectMsg);

    expect(mockedRedisPool.get).toBeCalledTimes(1);
    expect(mockedRedisPool.get).toBeCalledWith('CACHE.namespace-key');
    expect(mockedRedisPool.sendCommand).toBeCalledTimes(2);
    expect(mockedRedisPool.sendCommand).toHaveBeenCalledWith('SET', ['LOCK.namespace-key', uuid, 'NX', 'PX', '20000']);
    expect(mockedRedisPool.sendCommand).toHaveBeenCalledWith('EVAL', [
      'if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end',
      '1',
      'LOCK.namespace-key',
      uuid,
    ]);
    expect(mockedRedisPool.set).toBeCalledTimes(0);
    expect(fn).toBeCalledTimes(1);
  });

  it('nothing local or remote, acquires lock first time, calls function', async () => {
    const returnValue = 'TheReturn VALUE A';
    const uuid = 'AGDGADUWG113';
    const fn = jest.fn().mockResolvedValue(returnValue);

    jest
      .spyOn(global.Date, 'now')
      .mockImplementationOnce(() =>
        new Date('2019-06-29T11:01:58.135Z').valueOf()
      );
    mockedRedisPool.get.mockResolvedValueOnce(undefined);
    (uuidv4 as jest.Mock).mockReturnValue(uuid);
    mockedRedisPool.sendCommand.mockResolvedValueOnce('OK');
    mockedRedisPool.set.mockResolvedValueOnce('OK');
    mockedRedisPool.sendCommand.mockResolvedValueOnce('OK');

    expect(await redisCached('namespace', 'key', 0.5, 1.0, fn)).toEqual(returnValue);

    expect(mockedRedisPool.get).toBeCalledTimes(1);
    expect(mockedRedisPool.get).toBeCalledWith('CACHE.namespace-key');
    expect(mockedRedisPool.sendCommand).toBeCalledTimes(2);
    expect(mockedRedisPool.sendCommand).toHaveBeenCalledWith('SET', ['LOCK.namespace-key', uuid, 'NX', 'PX', '20000']);
    expect(mockedRedisPool.sendCommand).toHaveBeenCalledWith('EVAL', [
      'if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end',
      '1',
      'LOCK.namespace-key',
      uuid,
    ]);
    expect(mockedRedisPool.set).toBeCalledTimes(1);
    expect(mockedRedisPool.set).toBeCalledWith(
      'CACHE.namespace-key',
      `{"data":"${returnValue}","ttl":1561806118.635}`,
      1
    );
    expect(fn).toBeCalledTimes(1);
  });


  it('nothing local, data on remote, less than ttl', async () => {
    const returnValue = 'TheReturn VALUE A';
    const fn = jest.fn().mockResolvedValue(returnValue);

    jest
      .spyOn(global.Date, 'now')
      .mockImplementationOnce(() =>
        new Date('2019-06-29T11:01:58.135Z').valueOf()
      );
    mockedRedisPool.get.mockResolvedValueOnce(`{"data":"${returnValue}","ttl":1561806218.635}`);

    expect(await redisCached('namespace', 'key', 0.5, 1.0, fn)).toEqual(returnValue);

    expect(mockedRedisPool.get).toBeCalledTimes(1);
    expect(mockedRedisPool.get).toBeCalledWith('CACHE.namespace-key');
    expect(mockedRedisPool.set).toBeCalledTimes(0);
    expect(mockedRedisPool.sendCommand).toBeCalledTimes(0);
    expect(fn).toBeCalledTimes(0);
  });

  it('nothing on local, data on remote, above ttl and decide to not expire', async () => {
    const returnValue = 'TheReturn VALUE A';
    const fn = jest.fn().mockResolvedValue(returnValue);

    jest
      .spyOn(global.Date, 'now')
      .mockImplementationOnce(() =>
        new Date('2019-06-29T11:01:58.135Z').valueOf()
      );
    jest
      .spyOn(global.Math, 'random')
      .mockReturnValueOnce(1.0);
    mockedRedisPool.get.mockResolvedValueOnce(`{"data":"${returnValue}","ttl":1561806117.9}`);

    expect(await redisCached('namespace', 'key', 0.5, 1.0, fn)).toEqual(returnValue);

    expect(mockedRedisPool.get).toBeCalledTimes(1);
    expect(mockedRedisPool.get).toBeCalledWith('CACHE.namespace-key');
    expect(mockedRedisPool.set).toBeCalledTimes(0);
    expect(mockedRedisPool.sendCommand).toBeCalledTimes(0);
    expect(fn).toBeCalledTimes(0);
  });

  it('nothing on local, data on remote, above ttl & decide to expire', async () => {
    const returnValue = 'TheReturn VALUE A';
    const uuid = 'AGDGADUWG113';
    const fn = jest.fn().mockResolvedValue(returnValue);

    jest
      .spyOn(global.Date, 'now')
      .mockImplementationOnce(() =>
        new Date('2019-06-29T11:01:58.135Z').valueOf()
      )
      .mockImplementationOnce(() =>
        new Date('2019-06-29T11:01:59.135Z').valueOf()
      );
    jest
      .spyOn(global.Math, 'random')
      .mockReturnValueOnce(0.1);

    mockedRedisPool.get.mockResolvedValueOnce(`{"data":"${returnValue}","ttl":1561806117.9}`);
    (uuidv4 as jest.Mock).mockReturnValue(uuid);
    mockedRedisPool.sendCommand.mockResolvedValueOnce('OK');
    mockedRedisPool.set.mockResolvedValueOnce('OK');
    mockedRedisPool.sendCommand.mockResolvedValueOnce('OK');

    expect(await redisCached('namespace', 'key', 0.5, 1.0, fn)).toEqual(returnValue);

    expect(mockedRedisPool.get).toBeCalledTimes(1);
    expect(mockedRedisPool.get).toBeCalledWith('CACHE.namespace-key');
    expect(mockedRedisPool.sendCommand).toBeCalledTimes(2);
    expect(mockedRedisPool.sendCommand).toHaveBeenCalledWith('SET', ['LOCK.namespace-key', uuid, 'NX', 'PX', '20000']);
    expect(mockedRedisPool.sendCommand).toHaveBeenCalledWith('EVAL', [
      'if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end',
      '1',
      'LOCK.namespace-key',
      uuid,
    ]);
    expect(mockedRedisPool.set).toBeCalledTimes(1);
    expect(mockedRedisPool.set).toBeCalledWith(
      'CACHE.namespace-key',
      `{"data":"${returnValue}","ttl":1561806119.635}`,
      1
    );
    expect(fn).toBeCalledTimes(1);
  });

  it('nothing on local and remote, but cant acquire lock, after retrying gets data from remote', async () => {
    const returnValue = 'TheReturn VALUE A';
    const uuid = 'AGDGADUWG113';
    const fn = jest.fn().mockResolvedValue(returnValue);

    jest
      .spyOn(global.Date, 'now')
      .mockImplementationOnce(() =>
        new Date('2019-06-29T11:01:58.135Z').valueOf()
      );
    mockedRedisPool.get.mockResolvedValueOnce(undefined);
    mockedRedisPool.get.mockResolvedValueOnce(undefined);
    mockedRedisPool.get.mockResolvedValueOnce(undefined);
    mockedRedisPool.get.mockResolvedValueOnce('asdfasdfasdf');
    mockedRedisPool.get.mockResolvedValueOnce(`{"data":"${returnValue}","ttl":1561806218.635}`);

    (uuidv4 as jest.Mock).mockReturnValue(uuid);

    mockedRedisPool.sendCommand.mockResolvedValueOnce(undefined);

    expect(await redisCached('namespace', 'key', 0.5, 1.0, fn)).toEqual(returnValue);

    expect(mockedRedisPool.get).toBeCalledTimes(5);
    expect(mockedRedisPool.get).toBeCalledWith('CACHE.namespace-key');
    expect(mockedRedisPool.get).toBeCalledWith('LOCK.namespace-key');
    expect(fn).toBeCalledTimes(0);
  });
});

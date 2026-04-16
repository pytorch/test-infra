import { Mutex } from 'async-mutex';
import { Pool, createPool } from 'generic-pool';
import { RedisClientType, createClient } from 'redis';
import { mapReplacer, mapReviver } from './utils';

import { Config } from './config';
import LRU from 'lru-cache';
import { v4 as uuidv4 } from 'uuid';

interface RedisStore {
  ttl: number;
  data: unknown;
  version?: string;
}

let redisPool: Pool<RedisClientType> | undefined = undefined;

const localLocksMutex = new Mutex();

const localCache = new Map<string, LRU<string, unknown>>();
const localLocks = new Map<string, Map<string, Mutex>>();

export async function shutdownRedisPool() {
  if (redisPool !== undefined) {
    try {
      console.info('Draining redis pool');
      await redisPool.drain();
      console.info('Shutdown redis pool');
      await redisPool.clear();
    } catch (e) {
      /* istanbul ignore next */
      console.error(`Error shutting down reddis pool ${e}`);
    }

    redisPool = undefined;
    console.info('Redis pool shut down successfully');
  }
}

/* istanbul ignore next */
async function onSigterm() {
  console.info('[runtime] SIGTERM received');

  await shutdownRedisPool();

  console.info('[runtime] Waiting 2 seconds');
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.info('[runtime] exiting');
  process.exit(0);
}

export async function startupRedisPool() {
  if (redisPool === undefined) {
    console.info('Starting up redis pool');
    redisPool = createPool(
      {
        create: async () => {
          console.debug('Creating redis client');
          const client = createClient({
            url: `redis://${Config.Instance.redisEndpoint}:6379`,
          });
          client.on('error', (err) => {
            /* istanbul ignore next */
            throw new Error(err);
          });
          client.on('ready', () => {
            /* istanbul ignore next */
            console.debug('Redis client ready');
          });
          console.debug('Redis client connecting');
          await client.connect();
          console.debug('Redis client connected');
          return client as RedisClientType;
        },
        destroy: async (client) => {
          console.debug('Redis client destroy');
          await client.quit();
        },
      },
      {
        max: 5,
        min: 1,
      },
    );

    console.info('Setting up shutdown for redis pool');
    process.on('SIGTERM', onSigterm);
    console.info('Redis set up');
  }
}

export function clearLocalCache() {
  localCache.clear();
}

/* istanbul ignore next */
export function clearLocalCacheNamespace(nameSpace: string) {
  localCache.get(nameSpace)?.reset();
}

// Implements a local cache, with timeout and prevents multiple calls to callback once cache is expired
export async function locallyCached<T>(
  nameSpace: string,
  key: string,
  ttlSec: number,
  callback: () => Promise<T>,
): Promise<T> {
  if (!localCache.has(nameSpace)) {
    localCache.set(nameSpace, new LRU({ maxAge: ttlSec * 1000 }));
  }
  let cached: T | undefined | null = undefined;

  let tryGetLocalOrLock = true;
  while (tryGetLocalOrLock) {
    cached = localCache.get(nameSpace)?.get(key) as T;
    if (cached !== undefined && cached !== null) {
      console.debug(`Using local cache for ${nameSpace} ${key}...`);
      return cached;
    }
    console.debug(`could not find local cache for ${nameSpace} ${key}... tryng to get lock to perform request`);

    // the double check is just a optimization, avoiding the overhead of acquiring lock when there is no need
    // the second check, inside the runExclusive must be performed to avoid race conditions
    if (!localLocks.get(nameSpace)?.has(key)) {
      console.debug(`Getting local mutex for localLocksMutex`);
      await localLocksMutex.runExclusive(async () => {
        if (!localLocks.has(nameSpace)) {
          localLocks.set(nameSpace, new Map());
        }
        if (!localLocks.get(nameSpace)?.get(key)) {
          localLocks.get(nameSpace)?.set(key, new Mutex());
        }
      });
      console.debug(`Released local mutex for localLocksMutex`);
    }

    const mutex = localLocks.get(nameSpace)?.get(key) as Mutex;
    if (mutex.isLocked()) {
      console.debug(
        `could not get local lock, waiting for unlock and get data from cache... ` +
          `mutex.waitForUnlock() for ${nameSpace} ${key}`,
      );
      await mutex.waitForUnlock();
    } else {
      await mutex.runExclusive(async () => {
        console.debug(`Obtained mutex.runExclusive for ${nameSpace} ${key}`);
        cached = await callback();
        localCache.get(nameSpace)?.set(key, cached);
        tryGetLocalOrLock = false;
      });
      console.debug(`Successfully mutex.runExclusive for ${nameSpace} ${key}`);
    }
  }

  return cached as T;
}

async function redisAcquireLock(lockKey: string, ttlS: number): Promise<string | undefined> {
  if (!redisPool) throw Error('Redis should be initialized!');

  const uid = uuidv4();

  const result = await redisPool.use(async (client: RedisClientType) => {
    return await client.sendCommand(['SET', lockKey, uid, 'NX', 'PX', `${(ttlS * 1000).toFixed()}`]);
  });

  if (result !== 'OK') {
    console.debug(`Redis lock ${lockKey} - not acquired`);
    return undefined;
  }

  console.debug(`Redis lock ${lockKey} - acquired with id ${uid}`);
  return uid;
}

async function redisReleaseLock(lockKey: string, lockUUID: string) {
  if (!redisPool) throw Error('Redis should be initialized!');

  const script =
    `if redis.call("get","${lockKey}") == "${lockUUID}" ` +
    `then return redis.call("del","${lockKey}") else return 0 end`;

  const lockReleaseResponse = await redisPool.use(async (client: RedisClientType) => {
    return await client.eval(script);
  });

  /* istanbul ignore next */
  if (!lockReleaseResponse) {
    throw new Error(`Could not release Redis lock ${lockKey} with ${lockUUID} - Received "${lockReleaseResponse}"`);
  }
}

export async function redisClearCacheKeyPattern(namespace: string, key: string) {
  const queryKey = `${Config.Instance.environment}.CACHE.${namespace}-${key}`;

  await startupRedisPool();
  if (!redisPool) throw Error('Redis should be initialized!');

  console.warn(`Cleaning Redis Cache for pattern ${queryKey}`);
  const client = await redisPool.acquire();
  console.debug(`Cleaning Redis Cache for pattern ${queryKey} - acquired client`);
  try {
    const keys = [];
    console.debug(`Cleaning Redis Cache for pattern ${queryKey} - running SCAN`);
    for await (const key of client.scanIterator({ MATCH: `${queryKey}*`, COUNT: 1000 })) {
      keys.push(key);
    }

    console.debug(`Cleaning Redis Cache for pattern ${queryKey} - found ${keys.length} keys to cleanup`);

    for (const key of keys) {
      await client.sendCommand(['UNLINK', key]);
    }

    console.debug(`Cleaning Redis Cache for pattern ${queryKey} - All ${keys.length} UNLINKed`);
    await redisPool.release(client);
  } catch (e) {
    /* istanbul ignore next */
    console.error(`Error cleaning Redis Cache for pattern ${queryKey} - ${e}`);
    /* istanbul ignore next */
    redisPool.destroy(client);
    /* istanbul ignore next */
    console.debug(`Cleaning Redis Cache for pattern ${queryKey} - released client`);
  }
}

export async function redisLocked<T>(
  nameSpace: string,
  key: string,
  callback: () => Promise<T>,
  tryRead: (() => Promise<T>) | undefined,
  lockTimeoutS = 20,
  acquireTimeoutS: undefined | number = undefined,
): Promise<T> {
  await startupRedisPool();
  if (!redisPool) throw Error('Redis should be initialized!');

  const lockKey = `${Config.Instance.environment}.${Config.Instance.datetimeDeploy}.LOCK.${nameSpace}-${key}`;
  const acquireTimeout = +new Date() / 1000 + (acquireTimeoutS || lockTimeoutS);

  while (+new Date() / 1000 < acquireTimeout) {
    try {
      if (tryRead !== undefined) {
        return await tryRead();
      }
    } catch (e) {
      console.debug(`Error trying to read ${nameSpace}-${key} ${e}`);
    }

    console.debug(`Trying to acquire redis lock ${lockKey} ${lockTimeoutS}`);
    const lockUUID = await redisAcquireLock(lockKey, lockTimeoutS);
    if (lockUUID !== undefined) {
      try {
        return await callback();
      } finally {
        await redisReleaseLock(lockKey, lockUUID);
      }
    } else {
      console.debug('Failed to acquire redis lock...');
      for (let i = 0; i < Math.floor(acquireTimeoutS || lockTimeoutS); i++) {
        const lockStatus: string | undefined | null = await redisPool.use(async (client: RedisClientType) => {
          return await client.get(lockKey);
        });

        if (lockStatus !== undefined && lockStatus !== null) {
          console.debug(`redis lock is now available... ${lockStatus}`);
          break;
        } else {
          console.debug('redis lock is still in use...');
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /* istanbul ignore next */
  throw new Error(`Could not acquire lock for ${nameSpace}-${key}`);
}

export async function getExperimentValue<T>(experimentKey: string, defaultValue: T): Promise<T> {
  return locallyCached('EXPERIMENT', experimentKey, 60, async (): Promise<T> => {
    await startupRedisPool();
    if (!redisPool) throw Error('Redis should be initialized!');

    const queryKey = `${Config.Instance.environment}.EXPERIMENT.${experimentKey}`;

    console.debug(`Checking redis entry for experiment ${experimentKey} (${queryKey})`);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const experimentValue: any = await redisPool.use(async (client: RedisClientType) => {
        return await client.get(queryKey);
      });

      if (experimentValue === undefined || experimentValue === null) {
        console.debug(`Experiment ${queryKey} not found, returning default value ${defaultValue}`);
        return defaultValue;
      }

      if (typeof defaultValue === 'number' && typeof experimentValue === 'string') {
        const numValue = Number(experimentValue);
        if (!isNaN(numValue)) {
          console.debug(`Experiment ${queryKey} found and converted to number, returning experiment value ${numValue}`);
          return numValue as T;
        } else {
          console.warn(
            `Experiment ${queryKey} found but value is not a valid number: ` +
              `${experimentValue}, returning default value ${defaultValue}`,
          );
          return defaultValue;
        }
      }

      if (typeof defaultValue === typeof experimentValue) {
        console.debug(
          `Experiment ${queryKey} found and with the correct type (${typeof experimentValue}),` +
            ` returning experiment value ${experimentValue}`,
        );
        return experimentValue;
      }
    } catch (e) {
      console.error(`Error retrieving experiment ${queryKey}, returning default value ${defaultValue}: ${e}`);
    }

    return defaultValue;
  });
}

export async function getJoinedStressTestExperiment(experimentKey: string, runnerName: string): Promise<boolean> {
  const runnerNameSuffix = await getExperimentValue('RUNNER_NAME_SUFFIX', '');
  if (runnerNameSuffix === undefined || runnerNameSuffix === null || runnerNameSuffix === '') {
    console.debug(`Experiment ${experimentKey} check ignored, as RUNNER_NAME_SUFFIX is not set`);
    return false;
  }

  if (!runnerName.endsWith(runnerNameSuffix)) {
    console.debug(
      `Runner name ${runnerName} does not match suffix ${runnerNameSuffix} when checking experiment ${experimentKey}`,
    );
    return false;
  }

  const experimentValue = await getExperimentValue(experimentKey, 0);

  if (Math.random() * 100 < experimentValue) {
    console.debug(
      `Enabling experiment ${experimentKey} for runner ${runnerName}. ` +
        `Reached probability threshold of ${experimentValue}%`,
    );
    return true;
  }

  console.debug(
    `Skipping experiment ${experimentKey} for runner ${runnerName}. ` +
      `Didn't reach probability threshold of ${experimentValue}%`,
  );
  return false;
}

export async function redisCached<T>(
  nameSpace: string,
  key: string,
  ttlSec: number,
  jitterPct: number,
  callback: () => Promise<T>,
  lockTimeoutS = 20,
): Promise<T> {
  return await locallyCached(nameSpace, key, ttlSec * 0.3, async (): Promise<T> => {
    const queryKey = `${Config.Instance.environment}.${Config.Instance.datetimeDeploy}.CACHE.${nameSpace}-${key}`;

    let cached: T | undefined = undefined;

    return await redisLocked(
      nameSpace,
      key,
      async () => {
        if (!redisPool) throw Error('Redis should be initialized!');

        console.debug(`Calling callback for ${queryKey}`);
        cached = await callback();
        const newDt: RedisStore = {
          data: cached,
          ttl: Date.now() / 1000 + ttlSec,
          version: Config.Instance.datetimeDeploy,
        };
        await redisPool.use(async (client: RedisClientType) => {
          return await client.set(queryKey, JSON.stringify(newDt, mapReplacer), { EX: ttlSec * (1 + jitterPct) });
        });

        console.debug(`Registered query response in Redis for ${queryKey}`);
        return cached;
      },
      async () => {
        if (!redisPool) throw Error('Redis should be initialized!');

        console.debug(`Trying to get a redis client ${queryKey}`);
        const redisResponse: string | undefined | null = await redisPool.use(async (client: RedisClientType) => {
          console.debug(`Redis client obtained, running get ${queryKey}`);
          return await client.get(queryKey);
        });

        if (redisResponse !== undefined && redisResponse !== null) {
          const redisData = JSON.parse(redisResponse, mapReviver) as RedisStore;

          const jitterDiff = (Date.now() / 1000 - redisData.ttl) / (ttlSec * jitterPct);
          if (Math.random() > jitterDiff && redisData.version === Config.Instance.datetimeDeploy) {
            console.debug(`Using redis cache for ${queryKey}...`);
            return redisData.data as T;
          }

          console.log(`Cache expired with ${jitterDiff} for ${queryKey}...`);
        } else {
          console.debug(`Could not find ${queryKey} in redis`);
        }

        throw new Error('Cache not found');
      },
      lockTimeoutS,
      lockTimeoutS,
    );
  });
}

import { Config } from './config';
import LRU from 'lru-cache';
import { Mutex, tryAcquire, E_ALREADY_LOCKED } from 'async-mutex';
import { RedisConnectionPool } from 'redis-connection-pool';
import { v4 as uuidv4 } from 'uuid';
import redisPoolFactory from 'redis-connection-pool';
import { mapReviver, mapReplacer } from './utils';

interface RedisStore {
  ttl: number;
  data: unknown;
  version?: string;
}

let redisPool: RedisConnectionPool | undefined = undefined;

const localLocksMutex = new Mutex();

const localCache = new Map<string, LRU<string, unknown>>();
const localLocks = new Map<string, Map<string, Mutex>>();

export async function shutdownRedisPool() {
  if (redisPool !== undefined) {
    console.info('Shutdown redis pool');

    try {
      await redisPool.shutdown();
    } catch (e) {
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

async function startupRedisPool() {
  if (redisPool === undefined) {
    console.info('Starting up redis pool');
    redisPool = await redisPoolFactory('scaleRunnersCache', {
      max_clients: 5,
      redis: {
        url: `redis://${Config.Instance.redisEndpoint}:6379`,
      },
    });

    console.info('Setting up shutdown for redis pool');
    process.on('SIGTERM', onSigterm);
    console.info('Redis set up');
  }
}

export function clearLocalCache() {
  localCache.clear();
}

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
    localCache.set(nameSpace, new LRU({ maxAge: ttlSec * 0.2 * 1000 }));
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
      await localLocksMutex.runExclusive(async () => {
        if (!localLocks.has(nameSpace)) {
          localLocks.set(nameSpace, new Map());
        }
        if (!localLocks.get(nameSpace)?.get(key)) {
          localLocks.get(nameSpace)?.set(key, new Mutex());
        }
      });
    }

    const mutex = localLocks.get(nameSpace)?.get(key) as Mutex;
    try {
      await tryAcquire(mutex).runExclusive(async () => {
        cached = await callback();
        localCache.get(nameSpace)?.set(key, cached);
        tryGetLocalOrLock = false;
      });
    } catch (e) {
      if (e !== E_ALREADY_LOCKED) {
        throw e;
      } else {
        console.debug('could not get local lock, waiting for unlock and get data from cache...');
        await mutex.waitForUnlock();
      }
    }
  }

  return cached as T;
}

async function redisAcquireLock(lockKey: string, ttlS: number): Promise<string | undefined> {
  const uid = uuidv4();
  const result = await redisPool?.sendCommand('SET', [lockKey, uid, 'NX', 'PX', `${(ttlS * 1000).toFixed()}`]);
  if (result !== 'OK') {
    return undefined;
  }
  return uid;
}

async function redisReleaseLock(lockKey: string, lockUUID: string) {
  if (!redisPool) return;
  const script =
    `if redis.call("get","${lockKey}") == "${lockUUID}" ` +
    `then return redis.call("del","${lockKey}") else return 0 end`;
  const client = await redisPool.pool.acquire();
  try {
    await client.eval(script);
  } finally {
    redisPool.pool.release(client);
  }
}

export async function redisCached<T>(
  nameSpace: string,
  key: string,
  ttlSec: number,
  jitterPct: number,
  callback: () => Promise<T>,
  lockTimeoutS = 20,
): Promise<T> {
  return locallyCached(nameSpace, key, ttlSec, async (): Promise<T> => {
    const queryKey = `${Config.Instance.environment}.CACHE.${nameSpace}-${key}`;
    const lockKey = `${Config.Instance.environment}.${Config.Instance.datetimeDeploy}.LOCK.${nameSpace}-${key}`;

    await startupRedisPool();

    let cached: T | undefined = undefined;
    /* eslint-disable-next-line no-constant-condition */
    while (true) {
      const redisResponse: string | undefined | null = await redisPool?.get(queryKey);

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

      const lockUUID = await redisAcquireLock(lockKey, lockTimeoutS);
      if (lockUUID !== undefined) {
        try {
          console.debug(`Calling callback for ${queryKey}`);
          cached = await callback();
          const newDt: RedisStore = {
            data: cached,
            ttl: Date.now() / 1000 + ttlSec,
            version: Config.Instance.datetimeDeploy,
          };
          redisPool?.set(queryKey, JSON.stringify(newDt, mapReplacer), ttlSec * (1 + jitterPct));
          break;
        } finally {
          redisReleaseLock(lockKey, lockUUID);
        }
      } else {
        console.debug('Failed to acquire redis lock...');
        for (let i = 0; i < lockTimeoutS; i++) {
          if (redisPool?.get(lockKey)) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    // YES this is a horrible way to write this return statement
    // but typescript is dbumb and it can't identify that the while will only break if
    // cache is set, returning inside the while then triggers errors related to possible undefined
    // return of the function (also dumb)
    return cached as T;
  });
}

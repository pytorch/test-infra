import { RequestError } from '@octokit/request-error';

export interface Repo {
  owner: string;
  repo: string;
}

export interface RunnerInfo {
  applicationDeployDatetime?: string;
  awsRegion: string;
  environment?: string;
  ghRunnerId?: string;
  instanceId: string;
  launchTime?: Date;
  org?: string;
  repo?: string;
  runnerType?: string;
  instanceManagement?: string;
}

export function getRepoKey(repo: Repo): string {
  return `${repo.owner}/${repo.repo}`;
}

export function isGHRateLimitError(e: unknown) {
  const requestErr = e as RequestError | null;
  const headers = requestErr?.headers || requestErr?.response?.headers;
  return requestErr?.status === 403 && headers?.['x-ratelimit-remaining'] === '0';
}

export function getBoolean(value: string | number | undefined | boolean, defaultVal = false): boolean {
  if (value === undefined) return defaultVal;

  if (typeof value === 'string') value = value.toLowerCase();

  switch (value) {
    case true:
    case 'true':
    case 1:
    case 1.0:
    case '1':
    case '1.0':
    case 'on':
    case 'yes':
      return true;

    case false:
    case 'false':
    case 0:
    case 0.0:
    case '0':
    case '0.0':
    case 'off':
    case 'no':
      return false;

    default:
      console.warn(`Unrecognized value at getBoolean: ${value}, returning default ${defaultVal}`);
      return defaultVal;
  }
}

export async function expBackOff<T>(
  callback: () => Promise<T>,
  startMs = 3000,
  maxMs = 20000,
  backOffFactor = 2,
): Promise<T> {
  let expBackOffMs = startMs;
  for (;;) {
    try {
      return await callback();
    } catch (e) {
      if (`${e}`.includes('RequestLimitExceeded') || `${e}`.includes('ThrottlingException') || isGHRateLimitError(e)) {
        if (expBackOffMs > maxMs) {
          throw e;
        }
        await new Promise((resolve) => setTimeout(resolve, expBackOffMs));
        expBackOffMs = expBackOffMs * backOffFactor;
      } else {
        throw e;
      }
    }
  }
}

export function getRepo(repoDef: string, repoName?: string): Repo {
  try {
    if (repoName !== undefined) {
      return { owner: repoDef, repo: repoName };
    }

    const repoArr = repoDef.split('/');
    if (repoArr.length != 2) {
      throw Error('getRepo: repoDef string must be in the format "owner/repo_name"');
    }
    return { owner: repoArr[0], repo: repoArr[1] };
  } catch (e) {
    console.error(`[getRepo]: ${e}`);
    throw e;
  }
}

export function groupBy<T, V>(lst: T[], keyGetter: (itm: T) => V): Map<V, Array<T>> {
  const map = new Map<V, Array<T>>();
  for (const itm of lst) {
    const key = keyGetter(itm);
    const collection = map.get(key);
    if (collection !== undefined) {
      collection.push(itm);
    } else {
      map.set(key, [itm]);
    }
  }
  return map;
}

export function getDelayWithJitter(delayBase: number, jitter: number) {
  return Math.max(0, delayBase) * (1 + Math.random() * Math.max(0, jitter));
}

export function getDelayWithJitterRetryCount(retryCount: number, delayBase: number, jitter: number) {
  return getDelayWithJitter(Math.max(0, delayBase) * Math.pow(2, Math.max(0, retryCount)), jitter);
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export function mapReplacer(key: string, value: any) {
  if (value instanceof Map) {
    return {
      dataType: 'Map',
      value: Array.from(value.entries()),
    };
  } else {
    return value;
  }
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export function mapReviver(key: string, value: any) {
  if (typeof value === 'object' && value !== null) {
    if (value.dataType === 'Map') {
      return new Map(value.value);
    }
  }
  return value;
}

export function shuffleArrayInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

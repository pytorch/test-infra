export interface Repo {
  owner: string;
  repo: string;
}

export interface RunnerInfo {
  instanceId: string;
  launchTime?: Date;
  repo?: string;
  org?: string;
  runnerType?: string;
  ghRunnerId?: string;
  environment?: string;
}

export function getRepoKey(repo: Repo): string {
  return `${repo.owner}/${repo.repo}`;
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
      if (`${e}`.includes('RequestLimitExceeded')) {
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

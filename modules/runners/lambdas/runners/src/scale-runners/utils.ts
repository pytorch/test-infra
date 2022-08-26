export interface Repo {
  owner: string;
  repo: string;
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

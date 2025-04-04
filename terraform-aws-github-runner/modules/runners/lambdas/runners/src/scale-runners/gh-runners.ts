import { Repo, getRepoKey, expBackOff } from './utils';
import { RunnerType, RunnerTypeScaleConfig } from './runners';
import { createGithubAuth, createOctoClient } from './gh-auth';
import { locallyCached, redisCached, clearLocalCacheNamespace, redisClearCacheKeyPattern } from './cache';

import { Config } from './config';
import LRU from 'lru-cache';
import { Metrics } from './metrics';
import { Octokit } from '@octokit/rest';
import YAML from 'yaml';

const ghMainClientCache = new LRU({ maxAge: 10 * 1000 });
const ghClientCache = new LRU({ maxAge: 10 * 1000 });

export interface GHRateLimitInfo {
  limit: number;
  remaining: number;
  used: number;
}

export async function resetGHRunnersCaches() {
  await redisClearCacheKeyPattern('ghRunners', '');
  clearLocalCacheNamespace('ghRunners');
  ghClientCache.reset();
  ghMainClientCache.reset();
}

async function getGithubClient(metrics: Metrics): Promise<Octokit> {
  try {
    let githubClient: Octokit | undefined = ghMainClientCache.get('client') as Octokit;
    /* istanbul ignore next */
    if (githubClient === undefined) {
      console.debug(`[getGithubClient] Need to instantiate base githubClient`);
      const ghAuth = await createGithubAuth(undefined, 'app', Config.Instance.ghesUrlApi, metrics);
      githubClient = createOctoClient(ghAuth, Config.Instance.ghesUrlApi);
      ghMainClientCache.set('client', githubClient);
    }
    return githubClient;
  } catch (e) {
    console.error(`[getGithubClient]: ${e}`);
    throw e;
  }
}

export async function createGitHubClientForRunnerRepo(repo: Repo, metrics: Metrics): Promise<Octokit> {
  try {
    return await createGitHubClientForRunner(metrics, getRepoKey(repo), async () => {
      try {
        return await redisCached(
          'ghRunners',
          `createGitHubClientForRunnerRepo-${repo.owner}-${repo.repo}`,
          10 * 60,
          0.5,
          async () => {
            const localGithubClient = await getGithubClient(metrics);
            return await expBackOff(() => {
              return metrics.trackRequest(
                metrics.getRepoInstallationGHCallSuccess,
                metrics.getRepoInstallationGHCallFailure,
                async () => {
                  return (await localGithubClient.apps.getRepoInstallation({ ...repo })).data.id;
                },
              );
            });
          },
        );
      } catch (e) {
        console.error(`[createGitHubClientForRunnerRepo <anonymous>]: ${e}`);
        throw e;
      }
    });
  } catch (e) {
    console.error(`[createGitHubClientForRunnerRepo]: ${e}`);
    throw e;
  }
}

export async function createGitHubClientForRunnerOrg(organization: string, metrics: Metrics): Promise<Octokit> {
  try {
    return await createGitHubClientForRunner(metrics, organization, async () => {
      try {
        return await redisCached(
          'ghRunners',
          `createGitHubClientForRunnerOrg-${organization}`,
          10 * 60,
          0.5,
          async () => {
            const localGithubClient = await getGithubClient(metrics);
            return await expBackOff(() => {
              return metrics.trackRequest(
                metrics.getRepoInstallationGHCallSuccess,
                metrics.getRepoInstallationGHCallFailure,
                async () => {
                  return (await localGithubClient.apps.getOrgInstallation({ org: organization })).data.id;
                },
              );
            });
          },
        );
      } catch (e) {
        console.error(`[createGitHubClientForRunnerOrg <anonymous>]: ${e}`);
        throw e;
      }
    });
  } catch (e) {
    console.error(`[createGitHubClientForRunnerOrg]: ${e}`);
    throw e;
  }
}

export async function createGitHubClientForRunnerInstallId(installationId: number, metrics: Metrics): Promise<Octokit> {
  try {
    return await createGitHubClientForRunner(metrics, `${installationId}`, async () => {
      return installationId;
    });
  } catch (e) {
    console.error(`[createGitHubClientForRunnerInstallId]: ${e}`);
    throw e;
  }
}

async function createGitHubClientForRunner(
  metrics: Metrics,
  key: string,
  installationIdCallback: () => Promise<number>,
): Promise<Octokit> {
  try {
    const cachedOctokit = ghClientCache.get(key) as Octokit;
    if (cachedOctokit) {
      return cachedOctokit;
    }

    console.debug(`[createGitHubClientForRunner] Cache miss for ${key}`);
    const installationId = await installationIdCallback();
    const ghAuth2 = await createGithubAuth(installationId, 'installation', Config.Instance.ghesUrlApi, metrics);
    const octokit = createOctoClient(ghAuth2, Config.Instance.ghesUrlApi);

    ghClientCache.set(key, octokit);
    return octokit;
  } catch (e) {
    console.error(`[createGitHubClientForRunner]: ${e}`);
    throw e;
  }
}

/**
 * Extract the inner type of a promise if any
 */
type UnboxPromise<T> = T extends Promise<infer U> ? U : T;

export type GhRunners = UnboxPromise<ReturnType<Octokit['actions']['listSelfHostedRunnersForRepo']>>['data']['runners'];

export async function removeGithubRunnerRepo(ghRunnerId: number, repo: Repo, metrics: Metrics) {
  const githubAppClient = await createGitHubClientForRunnerRepo(repo, metrics);
  const result = await expBackOff(() => {
    return metrics.trackRequest(
      metrics.deleteSelfHostedRunnerFromRepoGHCallSuccess,
      metrics.deleteSelfHostedRunnerFromRepoGHCallFailure,
      () => {
        return githubAppClient.actions.deleteSelfHostedRunnerFromRepo({
          ...repo,
          runner_id: ghRunnerId,
        });
      },
    );
  });

  /* istanbul ignore next */
  if ((result?.status ?? 0) != 204) {
    throw (
      `Request deleteSelfHostedRunnerFromRepoGHCallSuccess returned status code different than 204: ` +
      `${result?.status ?? 0} for ${repo} ${ghRunnerId}`
    );
  }
}

export async function removeGithubRunnerOrg(ghRunnerId: number, org: string, metrics: Metrics) {
  const githubAppClient = await createGitHubClientForRunnerOrg(org, metrics);
  const result = await expBackOff(() => {
    return metrics.trackRequest(
      metrics.deleteSelfHostedRunnerFromOrgGHCallSuccess,
      metrics.deleteSelfHostedRunnerFromOrgGHCallFailure,
      () => {
        return githubAppClient.actions.deleteSelfHostedRunnerFromOrg({
          org: org,
          runner_id: ghRunnerId,
        });
      },
    );
  });

  /* istanbul ignore next */
  if ((result?.status ?? 0) != 204) {
    throw (
      `Request deleteSelfHostedRunnerFromRepoGHCallSuccess returned status code different than 204: ` +
      `${result?.status ?? 0} for ${org} ${ghRunnerId}`
    );
  }
}

export async function listGithubRunnersRepo(repo: Repo, metrics: Metrics): Promise<GhRunners> {
  try {
    try {
      return await redisCached('ghRunners', `listGithubRunnersRepo-${repo.owner}-${repo.repo}`, 60, 0.5, async () => {
        const client = await createGitHubClientForRunnerRepo(repo, metrics);
        return await expBackOff(() => {
          return metrics.trackRequest(
            metrics.listSelfHostedRunnersForRepoGHCallSuccess,
            metrics.listSelfHostedRunnersForRepoGHCallFailure,
            () => {
              return client.paginate(client.actions.listSelfHostedRunnersForRepo, {
                ...repo,
                per_page: 100,
              });
            },
          );
        });
      });
    } catch (e) {
      console.error(`[listGithubRunnersRepo <anonymous>]: ${e}`);
      throw e;
    }
  } catch (e) {
    console.error(`[listGithubRunnersRepo]: ${e}`);
    throw e;
  }
}

export async function listGithubRunnersOrg(org: string, metrics: Metrics): Promise<GhRunners> {
  try {
    try {
      return await redisCached('ghRunners', `listGithubRunnersOrg-${org}`, 60, 0.5, async () => {
        const client = await createGitHubClientForRunnerOrg(org, metrics);
        return await expBackOff(() => {
          return metrics.trackRequest(
            metrics.listSelfHostedRunnersForOrgGHCallSuccess,
            metrics.listSelfHostedRunnersForOrgGHCallFailure,
            () => {
              return client.paginate(client.actions.listSelfHostedRunnersForOrg, {
                org: org,
                per_page: 100,
              });
            },
          );
        });
      });
    } catch (e) {
      console.error(`[listGithubRunnersOrg <anonymous>]: ${e}`);
      throw e;
    }
  } catch (e) {
    console.error(`[listGithubRunnersOrg]: ${e}`);
    throw e;
  }
}

export type GhRunner = UnboxPromise<ReturnType<Octokit['actions']['getSelfHostedRunnerForRepo']>>['data'];

export async function getRunnerRepo(repo: Repo, runnerID: string, metrics: Metrics): Promise<GhRunner | undefined> {
  try {
    return await locallyCached('ghRunners', `getRunnerRepo-${repo.owner}.${repo.repo}-${runnerID}`, 60, async () => {
      const client = await createGitHubClientForRunnerRepo(repo, metrics);
      return (
        await expBackOff(() => {
          return metrics.trackRequest(
            metrics.getSelfHostedRunnerForRepoGHCallSuccess,
            metrics.getSelfHostedRunnerForRepoGHCallFailure,
            () => {
              return client.actions.getSelfHostedRunnerForRepo({
                ...repo,
                runner_id: runnerID as unknown as number,
              });
            },
          );
        })
      ).data;
    });
  } catch (e) {
    console.warn(`[getRunnerRepo <inner try>]: ${e}`);
    return undefined;
  }
}

export async function getRunnerOrg(org: string, runnerID: string, metrics: Metrics): Promise<GhRunner | undefined> {
  const client = await createGitHubClientForRunnerOrg(org, metrics);

  try {
    return await locallyCached('ghRunners', `getRunnerOrg-${org}-${runnerID}`, 60, async () => {
      return (
        await expBackOff(() => {
          return metrics.trackRequest(
            metrics.getSelfHostedRunnerForOrgGHCallSuccess,
            metrics.getSelfHostedRunnerForOrgGHCallFailure,
            () => {
              return client.actions.getSelfHostedRunnerForOrg({
                org: org,
                runner_id: runnerID as unknown as number,
              });
            },
          );
        })
      ).data;
    });
  } catch (e) {
    console.warn(`[getRunnerOrg <inner try>]: ${e}`);
    return undefined;
  }
}

export async function getRunnerTypes(
  repo: Repo,
  metrics: Metrics,
  filepath = Config.Instance.scaleConfigRepoPath,
): Promise<Map<string, RunnerType>> {
  const alphaNumericStr = /^[a-zA-Z0-9.-]+$/;

  return await redisCached('ghRunners', `getRunnerTypes-${repo.owner}.${repo.repo}`, 10 * 60, 0.5, async () => {
    let status = 'noRun';
    try {
      status = 'doRun';
      /* istanbul ignore next */
      const githubAppClient = Config.Instance.enableOrganizationRunners
        ? await createGitHubClientForRunnerOrg(repo.owner, metrics)
        : await createGitHubClientForRunnerRepo(repo, metrics);

      const response = await expBackOff(() => {
        return metrics.trackRequest(metrics.reposGetContentGHCallSuccess, metrics.reposGetContentGHCallFailure, () => {
          return githubAppClient.repos.getContent({
            ...repo,
            path: filepath,
          });
        });
      });

      /* istanbul ignore next */
      const { content }: { content?: string } = { ...(response?.data || {}) } as { content?: string };
      if (response?.status != 200 || !content) {
        throw Error(
          `Issue (${response.status}) retrieving '${filepath}' for https://github.com/${repo.owner}/${repo.repo}/`,
        );
      }

      const buff = Buffer.from(content, 'base64');
      const configYml = buff.toString('ascii');

      console.debug(`'${filepath}' contents: ${configYml}`);

      const config = YAML.parse(configYml);
      const result: Map<string, RunnerTypeScaleConfig> = new Map(
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        (Object.entries(config.runner_types) as [string, any][]).map(([prop, runner_type]) => [
          prop,
          {
            /* istanbul ignore next */
            ami_experiment: runner_type.ami_experiment,
            /* istanbul ignore next */
            ami: runner_type.ami?.trim(),
            disk_size: runner_type.disk_size,
            instance_type: runner_type.instance_type,
            /* istanbul ignore next */
            is_ephemeral: runner_type.is_ephemeral || false,
            /* istanbul ignore next */
            labels: runner_type.labels?.map((label: string) => label.trim()),
            min_available: runner_type.min_available || Config.Instance.minAvailableRunners,
            max_available: runner_type.max_available,
            os: runner_type.os,
            runnerTypeName: prop,
            variants: new Map(Object.entries(runner_type.variants || {})),
          },
        ]),
      );

      Array.from(result.keys()).forEach((key) => {
        const runnerType = result.get(key);
        /* istanbul ignore next */
        if (runnerType?.variants === undefined) {
          return;
        }

        Array.from(runnerType.variants.keys()).forEach((variant) => {
          const variantType = runnerType.variants?.get(variant);
          /* istanbul ignore next */
          if (!variantType) {
            return;
          }

          let variantRunnTypeName: string;
          if (key.startsWith('lf.c.')) {
            variantRunnTypeName = `lf.c.${variant}.${key.slice(5)}`;
          } else if (key.startsWith('lf.')) {
            variantRunnTypeName = `lf.${variant}.${key.slice(3)}`;
          } else if (key.startsWith('c.')) {
            variantRunnTypeName = `c.${variant}.${key.slice(2)}`;
          } else {
            variantRunnTypeName = `${variant}.${key}`;
          }

          result.set(variantRunnTypeName, { ...runnerType, ...variantType, runnerTypeName: variantRunnTypeName });
        });
      });

      const filteredResult: Map<string, RunnerType> = new Map(
        [...result.entries()]
          .filter(
            ([, runnerType]) =>
              typeof runnerType.runnerTypeName === 'string' &&
              alphaNumericStr.test(runnerType.runnerTypeName) &&
              typeof runnerType.instance_type === 'string' &&
              alphaNumericStr.test(runnerType.instance_type) &&
              ['linux', 'windows'].includes(runnerType.os) &&
              /* istanbul ignore next */
              (runnerType.labels?.every((label) => typeof label === 'string' && alphaNumericStr.test(label)) ?? true) &&
              (typeof runnerType.disk_size === 'number' || runnerType.disk_size === undefined) &&
              (typeof runnerType.min_available === 'number' || runnerType.min_available === undefined) &&
              (typeof runnerType.max_available === 'number' || runnerType.max_available === undefined) &&
              (typeof runnerType.ami === 'string' || runnerType.ami === undefined) &&
              (typeof runnerType.ami_experiment?.ami === 'string' || runnerType.ami_experiment === undefined) &&
              (typeof runnerType.ami_experiment?.percentage === 'number' || runnerType.ami_experiment === undefined),
          )
          .map(([key, runnerType]) => {
            const rt: RunnerTypeScaleConfig = { ...runnerType };
            delete rt.variants;
            return [key, rt];
          }),
      );

      if (result.size != filteredResult.size) {
        console.error(
          `Some runner types were filtered out due to invalid values: ${result.size} -> ${filteredResult.size}`,
        );
        console.error(`Original runner types: ${JSON.stringify(Array.from(result.keys()).sort())}`);
        console.error(`Filtered runner types: ${JSON.stringify(Array.from(filteredResult.keys()).sort())}`);
      }

      status = 'success';
      return filteredResult;
    } catch (e) {
      console.error(`[getRunnerTypes]: ${e}`);
      throw e;
    } finally {
      if (status == 'doRun') {
        metrics.getRunnerTypesFailure();
      } else if (status == 'success') {
        metrics.getRunnerTypesSuccess();
      }
    }
  });
}

export async function createRegistrationTokenRepo(
  repo: Repo,
  metrics: Metrics,
  installationId?: number,
): Promise<string> {
  try {
    return await locallyCached('ghRunners', `createRegistrationTokenRepo-${repo.owner}.${repo.repo}`, 60, async () => {
      try {
        const githubInstallationClient = installationId
          ? await createGitHubClientForRunnerInstallId(installationId, metrics)
          : await createGitHubClientForRunnerRepo(repo, metrics);
        const response = await expBackOff(() => {
          return metrics.trackRequest(
            metrics.createRegistrationTokenForRepoGHCallSuccess,
            metrics.createRegistrationTokenForRepoGHCallFailure,
            () => {
              return githubInstallationClient.actions.createRegistrationTokenForRepo({ ...repo });
            },
          );
        });

        /* istanbul ignore next */
        if (response?.status != 201 || !response.data?.token) {
          throw Error(
            `[createRegistrationTokenRepo] Issue (${response.status}) retrieving registration token ` +
              `for https://github.com/${repo.owner}/${repo.repo}/`,
          );
        }
        return response.data.token;
      } catch (e) {
        console.error(`[createRegistrationTokenRepo <anonymous>]: ${e}`);
        throw e;
      }
    });
  } catch (e) {
    console.error(`[createRegistrationTokenRepo]: ${e}`);
    throw e;
  }
}

export async function createRegistrationTokenOrg(
  org: string,
  metrics: Metrics,
  installationId?: number,
): Promise<string> {
  try {
    return await locallyCached('ghRunners', `createRegistrationTokenOrg-${org}`, 60, async () => {
      try {
        const githubInstallationClient = installationId
          ? await createGitHubClientForRunnerInstallId(installationId, metrics)
          : await createGitHubClientForRunnerOrg(org, metrics);
        const response = await expBackOff(() => {
          return metrics.trackRequest(
            metrics.createRegistrationTokenForOrgGHCallSuccess,
            metrics.createRegistrationTokenForOrgGHCallFailure,
            () => {
              return githubInstallationClient.actions.createRegistrationTokenForOrg({ org: org });
            },
          );
        });
        /* istanbul ignore next */
        if (response?.status != 201 || !response.data?.token) {
          throw Error(
            `[createRegistrationTokenOrg] Issue (${response.status}) retrieving registration token ` +
              `for https://github.com/${org}/`,
          );
        }
        return response.data.token;
      } catch (e) {
        console.error(`[createRegistrationTokenOrg <anonymous>]: ${e}`);
        throw e;
      }
    });
  } catch (e) {
    console.error(`[createRegistrationTokenOrg]: ${e}`);
    throw e;
  }
}

export async function getGitHubRateLimit(repo: Repo, metrics: Metrics): Promise<GHRateLimitInfo> {
  try {
    return await redisCached('ghRunners', 'getGitHubRateLimit', 10, 0.5, async () => {
      try {
        const client = await createGitHubClientForRunnerRepo(repo, metrics);

        const rateLimit = await expBackOff(() => {
          return metrics.trackRequest(metrics.getGitHubRateLimitSuccess, metrics.getGitHubRateLimitFailure, () => {
            return client.rateLimit.get();
          });
        });

        const limit = Number(rateLimit.headers['x-ratelimit-limit']);
        const remaining = Number(rateLimit.headers['x-ratelimit-remaining']);
        const used = Number(rateLimit.headers['x-ratelimit-used']);

        return { used, limit, remaining };
      } catch (e) {
        /* istanbul ignore next */
        console.error(`[getGitHubRateLimit]: <anonymous> ${e}`);
        throw e;
      }
    });
  } catch (e) {
    /* istanbul ignore next */
    console.error(`[getGitHubRateLimit]: ${e}`);
    throw e;
  }
}

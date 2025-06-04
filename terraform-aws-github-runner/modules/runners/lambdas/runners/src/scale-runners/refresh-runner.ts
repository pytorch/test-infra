import { Config } from "./config";
import { getRunnerTypes } from "./gh-runners";
import { ScaleUpMetrics } from "./metrics";
import { getRunner, RunnerInputParameters } from "./runners";
import { innerCreateRunnerConfigArgument } from "./scale-up";
import { Repo } from "./utils";

export interface ActionRequestMessage {
  id: number;
  instanceId: string;
  awsRegion: string;
}

class RetryableRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableRefreshError';
  }
}

export async function refreshRunner(
  eventSource: string,
  payload: ActionRequestMessage,
  metrics: ScaleUpMetrics,
): Promise<void> {
  if (eventSource !== 'aws:sqs') {
    throw Error('Cannot handle non-SQS events!');
  }

  if (!payload.instanceId){
    console.warn(`[Skip]missing required field instance id `)
    return
}

if (!payload.awsRegion){
    console.warn(`[Skip]missing required field aws region `)
    return
}

  const instanceId = payload.instanceId
  const awsRegion = payload.awsRegion

  try {

    console.debug(`Start refresh a runner with instance id ${instanceId} in region ${awsRegion}`);
    const runner = await getRunner(metrics, instanceId, awsRegion)

    if (runner === undefined){
        console.warn(`Cannot find runner with instance id ${instanceId} in region ${awsRegion}`)
        return
    }

    const runnerTypeName = runner.runnerType;
    const repositoryOwner = runner.repositoryOwner;
    const repositoryName = runner.repositoryName;

    if (runnerTypeName === undefined){
        console.warn(`[Skip] Cannot find runner type name for runner with instance id ${instanceId} in region ${awsRegion}`)
        return
    }
    if (repositoryOwner === undefined){
        console.warn(`[Skip] Missing repositoryOwner for runner with instance id ${instanceId} in region ${awsRegion}`)
        return
    }
    if (repositoryName === undefined){
        console.warn(`[Skip] Missing  repository name for runner with instance id ${instanceId} in region ${awsRegion}`)
        return
    }

    if (runner.org === undefined && runner.repo === undefined){
        console.warn(`Missing repo and org from runner tags, one must be defined for runner with instance id ${instanceId} in region ${awsRegion}`)
        return
    }

    const ghesUrl = Config.Instance.ghesUrl
    if (ghesUrl === undefined){
        console.warn(`[Skip] Missing ghesUrl from config.instance, cannot refresh runner with instance id ${instanceId}`)
        return
    }
    const isEphemeral = true
    console.debug(`By default assuming the instance runnber is Ephemeral`)

    const isOrgRunner = runner.org!==undefined

    const extraLabels = runner?.runnerExtraLabels
    const typeLabels = runner?.runnerTypeLabels
    const runngerGroupName = runner?.runnerGroupName

    const repo: Repo = {
      owner: repositoryOwner,
      repo: repositoryName
    }

    export interface RunnerType extends RunnerTypeOptional {
      disk_size: number;
      instance_type: string;
      is_ephemeral: boolean;
      os: string;
      runnerTypeName: string;
    }
    runnerType: RunnerType = {
      disk_size: 0,
      instance_type: "",
      is_ephemeral: true,
      runnerTypeName: runnerTypeName
    }

    const createRunnerParams: RunnerInputParameters = {
              environment: Config.Instance.environment,
              runnerConfig: (awsRegion: string, experimentalRunner: boolean) => {
                return innerCreateRunnerConfigArgument(
                    runnerTypeName,
                    repositoryName,
                    repositoryOwner,
                    awsRegion,
                    metrics,
                    ghesUrl,
                    isOrgRunner,
                    isEphemeral,
                    experimentalRunner,
                    extraLabels,
                    typeLabels,
                    runngerGroupName
                );
              },
              runnerType: {

              },
              repositoryOwner: repo.owner,
              repositoryName: repo.repo,
            };
            if (Config.Instance.enableOrganizationRunners) {
              createRunnerParams.orgName = repo.owner;
            } else {
              createRunnerParams.repoName = getRepoKey(repo);
            }



    } catch (e) {
      /* istanbul ignore next */
      console.error(`Error refresh runner with  instance id: ${payload.instanceId} in region ${payload.awsRegion}: ${e}`);
    }


}

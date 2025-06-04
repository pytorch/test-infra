import moment from 'moment';
import { getJoinedStressTestExperiment, redisLocked } from './cache';
import { Config } from './config';
import { Metrics, ScaleUpMetrics } from './metrics';
import { getParameterNameForRunner, ListRunnerFilters, listRunners, RunnerInputParameters } from './runners';
import { RetryableScalingError } from './scale-up';
import { expBackOff, getRepo, RunnerInfo, shuffleArrayInPlace } from './utils';
import { EC2, SSM } from 'aws-sdk';

export async function tryReuseRunner(
  runnerParameters: RunnerInputParameters,
  metrics: ScaleUpMetrics,
): Promise<RunnerInfo> {
  const filters: ListRunnerFilters = buildRunnerFilters(runnerParameters);

  if (await getJoinedStressTestExperiment('stresstest_awsfail', runnerParameters.runnerType.runnerTypeName)) {
    console.warn(
      `Joining stress test stresstest_awsfail, failing AWS reuse for ${runnerParameters.runnerType.runnerTypeName}`,
    );
    throw new RetryableScalingError('Stress test stockout');
  }

  const runners = shuffleArrayInPlace(await listRunners(metrics, filters));

  /* istanbul ignore next */
  if (runnerParameters.orgName !== undefined) {
    metrics.runnersReuseFoundOrg(runners.length, runnerParameters.orgName, runnerParameters.runnerType.runnerTypeName);
  } else if (runnerParameters.repoName !== undefined) {
    metrics.runnersReuseFoundRepo(
      runners.length,
      getRepo(runnerParameters.repoName),
      runnerParameters.runnerType.runnerTypeName,
    );
  }

  const ec2M: Map<string, EC2> = new Map();
  const ssmM: Map<string, SSM> = new Map();

  for (const runner of runners) {
    try {
      if (!isRunnerReusable(runner,'tryReuseRunner')) continue;

      // additional check for scale-up
      if (runner.ephemeralRunnerFinished !== undefined) {
        const finishedAt = moment.unix(runner.ephemeralRunnerFinished);
        // when runner.ephemeralRunnerFinished is set, it indicates that the runner is at post-test stage of github,
        // there are some left cleanup in the ec2 instancdes, this gives the buffer to make sure we handle it gracefully.
        if (finishedAt > moment(new Date()).subtract(1, 'minutes').utc()) {
          console.debug(`[tryReuseRunner]: Runner ${runner.instanceId} finished a job less than a minute ago`);
          continue
        }
      }
      logRunnerScope(runnerParameters, metrics);

      // appies redis locks to avoid race condition between multiple scale-up/scale-down pipelines
      await redisLocked(
        `tryReuseRunner`,
        runner.instanceId,
        async () => {
          // I suspect it will be too many requests against GH API to check if runner is really offline
          const ssm = getOrInit(ssmM, runner.awsRegion, () => new SSM({ region: runner.awsRegion }));
          const ec2 = getOrInit(ec2M, runner.awsRegion, () => new EC2({ region: runner.awsRegion }));

          // Should come before removing other tags, this is useful so
          // there is always a tag present for scaleDown to know that
          // it can/will be reused and avoid deleting it.
          createTagForReuse(ec2, runner, metrics);
          console.debug(`[tryReuseRunner]: Reuse of runner ${runner.instanceId}: Created reuse tag`);

          // Delete EphemeralRunnerFinished tag to make sure other pipelines do not
          // pick this instance up since it's in next stage, in this case, it's in the ReplaceVolume stage.
          deleteTagForReuse(ec2, runner, metrics);
          console.debug(`[tryReuseRunner]: Reuse of runner ${runner.instanceId}: Tags deleted`);

          replaceRootVolume(ec2, runner, metrics);
          console.debug(`[tryReuseRunner]: Reuse of runner ${runner.instanceId}: Replace volume task created`);

          await addSSMParameterRunnerConfig(
            [runner.instanceId],
            runnerParameters,
            false,
            ssm,
            metrics,
            runner.awsRegion,
          );
          console.debug(`[tryReuseRunner]: Reuse of runner ${runner.instanceId}: Ssm parameter created`);
        },
        undefined,
        180,
        0.05,
      );

      logReuseSucces(runnerParameters, metrics, runners.length);
      return runner;
    } catch (e) {
      console.debug(
        `[tryReuseRunner]: something happened preventing to reuse runnerid ` +
          `${runner.instanceId}, either an error or it is already locked to be reused ${e}`,
      );
      logReuseFailure(runnerParameters, metrics, runners.length);
    }
  }

  logReuseGiveup(runnerParameters, metrics, runners.length);
  throw new Error('No runners available');
}


export async function tryRefreshRunner(
  runnerParameters: RunnerInputParameters,
  metrics: ScaleUpMetrics,
  runner: RunnerInfo,
){
  try {
    if (!isRunnerReusable(runner,'tryRefreshRunner')) {
        console.debug(`[tryRefreshRunner][Skip]: Runner ${runner.instanceId} is not reusable`);
        return;
      }

        logRunnerScope(runnerParameters, metrics);


         // appies redis locks to avoid race condition between multiple scale-up/scale-down pipelines
         await redisLocked(
          `tryRefreshRunner`,
          runner.instanceId,
          async () => {

            // set new ssm and ec2 clients
            const ssm = new SSM({ region: runner.awsRegion })
            const ec2 = new EC2({ region: runner.awsRegion })

            createTagForReuse(ec2, runner, metrics);
            console.debug(`[tryRefreshRunner]: Refrehing runner ${runner.instanceId}: Created reuse tag`);

            // Delete EphemeralRunnerFinished tag to make sure other pipelines do not
            // pick this instance up since it's in next stage, in this case, it's in the ReplaceVolume stage.
            deleteTagForReuse(ec2, runner, metrics);
            console.debug(`[tryRefreshRunner]: Refrehing runner ${runner.instanceId}: Tags deleted`);

            replaceRootVolume(ec2, runner, metrics);
            console.debug(`[tryRefreshRunner]: Reuse of runner ${runner.instanceId}: Replace volume task created`);

            await addSSMParameterRunnerConfig(
              [runner.instanceId],
              runnerParameters,
              false,
              ssm,
              metrics,
              runner.awsRegion,
            );
            console.debug(`[tryRefreshRunner]: Refrehing runner ${runner.instanceId}: Ssm parameter created`);
          },
          undefined,
          180,
          0.05,
        );
      logReuseSucces(runnerParameters, metrics, 1);
  } catch (e) {
    console.debug(
      `[tryReuseRunner]: something happened preventing to reuse runnerid ` +
        `${runner.instanceId}, either an error or it is already locked to be reused ${e}`,
    );
    logReuseFailure(runnerParameters, metrics, 1);
  }
}

function buildRunnerFilters(params: RunnerInputParameters): ListRunnerFilters {
  return {
    applicationDeployDatetime: Config.Instance.datetimeDeploy,
    containsTags: ['GithubRunnerID', 'EphemeralRunnerFinished'],
    environment: params.environment,
    instanceType: params.runnerType.instance_type,
    orgName: params.orgName,
    repoName: params.repoName,
    runnerType: params.runnerType.runnerTypeName,
  };
}

function getOrInit<T>(map: Map<string, T>, key: string, init: () => T): T {
  if (!map.has(key)) map.set(key, init());
  return map.get(key)!;
}

/**
 *
 * Create tags for ec2 instance ready for reuse
 * EBSVolumeReplacementRequestTm: record when was last time the task to replace volume was created.
 * scale-down pipeline will not delete the runner if the EBSVolumeReplacementRequestTmp is present
 *  and it's less than 5 mins.
 * Stage: record the stage of the runner, in this case, it's in the ReplaceEBSVolume.
 *  Refresh and scaleup pipelines will not reuse the runner if the Stage is present and it's ReplaceEBSVolume.
 * the stage tag will be removed once the replace volume task is completed at job's startup.sh
 * @param ec2
 * @param runner
 * @param metrics
 */
async function createTagForReuse(ec2: EC2, runner: RunnerInfo, metrics: ScaleUpMetrics) {
  await expBackOff(() =>
    metrics.trackRequestRegion(
      runner.awsRegion,
      metrics.ec2CreateTagsAWSCallSuccess,
      metrics.ec2CreateTagsAWSCallFailure,
      () =>
        ec2
          .createTags({
            Resources: [runner.instanceId],
            Tags: [
              { Key: 'EBSVolumeReplacementRequestTm', Value: `${Math.floor(Date.now() / 1000)}` },
              { Key: 'Stage', Value: 'ReplaceEBSVolume' },
            ],
          })
          .promise(),
    ),
  );
}

async function deleteTagForReuse(ec2: EC2, runner: RunnerInfo, metrics: ScaleUpMetrics) {
  await expBackOff(() => {
    return metrics.trackRequestRegion(
      runner.awsRegion,
      metrics.ec2DeleteTagsAWSCallSuccess,
      metrics.ec2DeleteTagsAWSCallFailure,
      () => {
        return ec2
          .deleteTags({
            Resources: [runner.instanceId],
            Tags: [{ Key: 'GithubRunnerID' }, { Key: 'EphemeralRunnerFinished' }],
          })
          .promise();
      },
    );
  });
}

async function replaceRootVolume(ec2: EC2, runner: RunnerInfo, metrics: ScaleUpMetrics) {
  await expBackOff(() =>
    metrics.trackRequestRegion(
      runner.awsRegion,
      metrics.ec2CreateReplaceRootVolumeTaskSuccess,
      metrics.ec2CreateReplaceRootVolumeTaskFailure,
      () =>
        ec2
          .createReplaceRootVolumeTask({
            InstanceId: runner.instanceId,
            DeleteReplacedRootVolume: true,
          })
          .promise(),
    ),
  );
}

// -------------------------------------------helper functions -----------------------------------------------

export async function addSSMParameterRunnerConfig(
  instancesId: string[],
  runnerParameters: RunnerInputParameters,
  customAmiExperiment: boolean,
  ssm: SSM,
  metrics: Metrics,
  awsRegion: string,
): Promise<void> {
  /* istanbul ignore next */
  if (instancesId.length == 0) {
    console.debug(`[${awsRegion}] No SSM parameter to be created, empty list of instances`);
    return;
  }

  let runnerConfig = await runnerParameters.runnerConfig(awsRegion, customAmiExperiment);
  if (customAmiExperiment) {
    runnerConfig = `${runnerConfig} #ON_AMI_EXPERIMENT`;
  }

  const createdSSMParams = await Promise.all(
    /* istanbul ignore next */
    instancesId.map(async (instanceId) => {
      const parameterName = getParameterNameForRunner(runnerParameters.environment, instanceId);
      return await expBackOff(() => {
        return metrics.trackRequestRegion(
          awsRegion,
          metrics.ssmPutParameterAWSCallSuccess,
          metrics.ssmPutParameterAWSCallFailure,
          async () => {
            await ssm
              .putParameter({
                Name: parameterName,
                Value: runnerConfig,
                Type: 'SecureString',
              })
              .promise();
            return parameterName;
          },
        );
      });
    }) ?? [],
  );
  console.debug(`[${awsRegion}] Created SSM Parameters(s): ${createdSSMParams.join(',')}`);
}

function logRunnerScope(runnerParameters: RunnerInputParameters, metrics: ScaleUpMetrics) {
  if (runnerParameters.orgName !== undefined) {
    metrics.runnersReuseTryOrg(1, runnerParameters.orgName, runnerParameters.runnerType.runnerTypeName);
  } else if (runnerParameters.repoName !== undefined) {
    metrics.runnersReuseTryRepo(1, getRepo(runnerParameters.repoName), runnerParameters.runnerType.runnerTypeName);
  }
}

function isRunnerReusable(runner: RunnerInfo, useCase:string): boolean {
  if (runner.ghRunnerId === undefined) {
    console.debug(`[${useCase}]: Runner ${runner.instanceId} does not have a GithubRunnerID tag`);
    return false;
  }
  if (runner.awsRegion === undefined) {
    console.debug(`[${useCase}]: Runner ${runner.instanceId} does not have a region`);
    return false;
  }
  if (runner.org === undefined && runner.repo === undefined) {
    console.debug(`[${useCase}]: Runner ${runner.instanceId} does not have org or repo`);
    return false;
  }

  if (runner.stage !== undefined && runner.stage === 'ReplaceEBSVolume') {
    console.debug(
      `[${useCase}]: Runner ${runner.instanceId} the runner is in ReplaceEBSVolume stage, skip to reuse it`,
    );
    return false;
  }

  if (runner.ephemeralRunnerFinished !== undefined) {
    const finishedAt = moment.unix(runner.ephemeralRunnerFinished);

    // since the runner finshed the previous github job, it's idling for a long time that it is likely to
    //  be caught in scale-down pipeline, we do not reuse it to avoid the race condition.
    if (finishedAt.add(Config.Instance.minimumRunningTimeInMinutes, 'minutes') < moment(new Date()).utc()) {
      console.debug(
        `[${useCase}]: Runner ${runner.instanceId} has been idle for over minimumRunningTimeInMinutes time of ` +
          `${Config.Instance.minimumRunningTimeInMinutes} mins, so it's likely to be reclaimed soon and should ` +
          `not be reused. It's been idle since ${finishedAt.format()}`,
      );
      return false;
    }
  }

  return true;
}

// ------------------------------------------- Metrics loggings -----------------------------------------------

function logReuseSucces(runnerParameters: RunnerInputParameters, metrics: ScaleUpMetrics, runnerLength: number) {
  if (runnerParameters.orgName !== undefined) {
    metrics.runnersReuseSuccessOrg(runnerLength, runnerParameters.orgName, runnerParameters.runnerType.runnerTypeName);
  } else if (runnerParameters.repoName !== undefined) {
    metrics.runnersReuseSuccessRepo(
      runnerLength,
      getRepo(runnerParameters.repoName),
      runnerParameters.runnerType.runnerTypeName,
    );
  }
}

function logReuseFailure(runnerParameters: RunnerInputParameters, metrics: ScaleUpMetrics, runnerLength: number) {
  if (runnerParameters.orgName !== undefined) {
    metrics.runnersReuseFailureOrg(runnerLength, runnerParameters.orgName, runnerParameters.runnerType.runnerTypeName);
  } else if (runnerParameters.repoName !== undefined) {
    metrics.runnersReuseFailureRepo(
      runnerLength,
      getRepo(runnerParameters.repoName),
      runnerParameters.runnerType.runnerTypeName,
    );
  }
}

function logReuseGiveup(runnerParameters: RunnerInputParameters, metrics: ScaleUpMetrics, runnerLength: number) {
  if (runnerParameters.orgName !== undefined) {
    metrics.runnersReuseGiveUpOrg(runnerLength, runnerParameters.orgName, runnerParameters.runnerType.runnerTypeName);
  } else if (runnerParameters.repoName !== undefined) {
    metrics.runnersReuseGiveUpRepo(
      runnerLength,
      getRepo(runnerParameters.repoName),
      runnerParameters.runnerType.runnerTypeName,
    );
  }
}

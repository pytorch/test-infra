import moment from 'moment';
import { Config } from './config';
import { resetSecretCache } from './gh-auth';
import {
  getRunnerOrg,
  getRunnerRepo,
  getRunnerTypes,
  GhRunner,
  listGithubRunnersOrg,
  listGithubRunnersRepo,
  removeGithubRunnerOrg,
  removeGithubRunnerRepo,
  resetGHRunnersCaches,
} from './gh-runners';
import { QueuedQueryMetrics, ScaleDownMetrics, sendMetricsAtTimeout, sendMetricsTimeoutVars } from './metrics';
import { doDeleteSSMParameter, listRunners, listSSMParameters, resetRunnersCaches, terminateRunner } from './runners';
import { getRepo, groupBy, Repo, RunnerInfo, isGHRateLimitError, shuffleArrayInPlace } from './utils';
import { SSM } from 'aws-sdk';

export class QueuedRunner {
    readonly runner_label:string;
    readonly org:string;
    readonly full_repo:string;
    readonly num_queued_jobs:number;
    readonly min_queue_time_min: number;
    readonly max_queue_time_min: number;

    constructor(runner_label:string, org: string, full_repo:string, num_queued_jobs:number, min_queue_time_min:number, max_queue_time_min:number ) {
        this.runner_label = runner_label;
        this.org = org;
        this.full_repo = full_repo;
        this.num_queued_jobs = num_queued_jobs;
        this.min_queue_time_min = min_queue_time_min;
        this.max_queue_time_min = max_queue_time_min;

    }
}

export async function checkQueuedQueries(runner: QueuedRunner, metrics:QueuedQueryMetrics): Promise<void> {
    console.log(`Runner: ${runner.runner_label} - ${runner.org} - ${runner.full_repo} - ${runner.num_queued_jobs} jobs queued`);
    // first check if runner even exists in our list of runners
    const runnerTypes = await getRunnerTypes(repo, metrics);

    // check min/max queue times
    for (let i = 0; i < runner.num_queued_jobs; i++) {
}

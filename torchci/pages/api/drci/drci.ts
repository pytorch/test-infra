import { PutObjectCommand } from "@aws-sdk/client-s3";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import {
  ADVISOR_PENDING_ALT_ATTR,
  DispatchMark,
} from "lib/advisor/advisorBadge";
import { buildAdvisorVerdictLines } from "lib/advisor/advisorComment";
import {
  autoDispatchAdvisorForNewFailures,
  autoDispatchEnabled,
  readDispatchStates,
  signalKeyForJob,
  toDispatchMark,
} from "lib/advisor/advisorDispatch";
import {
  extractSuppressed,
  suppressibleJobIds,
} from "lib/advisor/advisorSuppression";
import {
  fetchAdvisorVerdictRows,
  shouldReadAdvisorVerdicts,
} from "lib/advisor/advisorVerdictSource";
import { AdvisorVerdictRow } from "lib/advisorVerdictUtils";
import {
  getLabelsNeededByFiles,
  loadLabelerConfig,
} from "lib/bot/labelerConfigUtils";
import { updateInProgressLabels } from "lib/bot/preReviewUtils";
import {
  fetchJSON,
  getOpenStackPrs,
  isPyTorchPyTorch,
  isTime0,
  StackPr,
} from "lib/bot/utils";
import { queryClickhouse, queryClickhouseSaved } from "lib/clickhouse";
import { CrcrAllowlist, fetchCrcrAllowlist } from "lib/crcrAllowlist";
import {
  CANCELLED_STEP_ERROR,
  DRCI_COMMENT_AUTHOR,
  fetchPRLabels,
  FLAKY_RULES_JSON,
  formDrciComment,
  formDrciSevBody,
  getActiveSEVs,
  getDrciComment,
  getPRMergeCommits,
  getSuppressedLabels,
  hasSimilarFailures,
  hasSimilarFailuresInSamePR,
  HUD_URL,
  isExcludedFromAdvisor,
  isExcludedFromBrokenTrunk,
  isExcludedFromFlakiness,
  isExcludedFromSimilarityPostProcessing,
  isInfraFlakyJob,
  isLogClassifierFailed,
  NUM_MINUTES,
  OWNER,
} from "lib/drciUtils";
import { fetchCommitTimestamp } from "lib/fetchCommit";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import fetchPR from "lib/fetchPR";
import {
  fetchCrcrWorkflows,
  fetchFailedJobsFromCommits,
  fetchJobNamesFromCommits,
  fetchRecentWorkflows,
} from "lib/fetchRecentWorkflows";
import { getOctokit, getOctokitWithUserToken } from "lib/github";
import { buildGreenlightSections } from "lib/greenlight/greenlightComment";
import {
  GREENLIGHT_PENDING_ALT_ATTR,
  PR_REVIEW_PENDING_ALT_ATTR,
} from "lib/greenlight/greenlightSweep";
import {
  backfillMissingLog,
  getDisabledTestIssues,
  getOpenUnstableIssues,
  isDisabledTest,
  isDisabledTestMentionedInPR,
  isRecentlyCloseDisabledTest,
  isSameFailure,
  isUnstableJob,
  removeCancelledJobAfterRetry,
  removeJobNameSuffix,
} from "lib/jobUtils";
import { buildPrReviewSections } from "lib/prReview/prReviewComment";
import {
  fetchPrReviewHeadVerdicts,
  maybePromoteToReadyForReview,
  PromotionOutcome,
  PrReviewHeadVerdictRow,
  withStaleReviewNote,
} from "lib/prReview/readyForReviewPromotion";
import {
  extractPrStatusSection,
  fetchLiveLabels,
  fetchPrStatusState,
  hasPrStatusLabel,
  PR_STATUS_START,
  renderPrStatusSection,
} from "lib/prStatus";
import { drCIRateLimitExceeded, incrementDrCIRateLimit } from "lib/rateLimit";
import { getS3Client } from "lib/s3";
import { IssueData, PRandJobs, RecentWorkflowsData } from "lib/types";
import _ from "lodash";
import type { NextApiRequest, NextApiResponse } from "next";
import { Octokit } from "octokit";
dayjs.extend(utc);
export interface FlakyRule {
  name: string;
  captures: string[];
}

export interface UpdateCommentBody {
  repo: string;
  org?: string;
}

// Attempt to set the maxDuration of this serveless function on Vercel https://vercel.com/docs/functions/configuring-functions/duration,
// also according to https://vercel.com/docs/functions/runtimes#max-duration, the max duration
// for an enterprise account is 900
export const config = {
  maxDuration: 900,
};

function validateOrg(org: string | undefined): string {
  if (!org) {
    // Default to existing behavior.
    // TODO: Remove this fallback soon after this PR is merged
    return OWNER;
  }

  const normalizedOrg = org.toLowerCase();
  if (normalizedOrg === "pytorch" || normalizedOrg === "meta-pytorch") {
    return normalizedOrg;
  }

  throw new Error(
    `Invalid org: ${org}. Only 'pytorch' and 'meta-pytorch' are allowed.`
  );
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{
    [pr: number]: { [cat: string]: RecentWorkflowsData[] };
  }>
) {
  const authorization = req.headers.authorization;
  const botKey = process.env.DRCI_BOT_KEY;

  // `botKey &&` matters: without it an unset DRCI_BOT_KEY makes the comparison
  // undefined == undefined for a caller that sent no header, and every
  // anonymous request is admitted as the bot.
  if (botKey && authorization === botKey) {
    // Dr. CI bot key is used to update the comment, probably called from the
    // update Dr. CI workflow
  } else if (authorization) {
    // Authorization provided, probably a user calling it.
    // Check that they are only updating a single PR
    const { prNumber } = req.query;
    if (prNumber === undefined) {
      res.status(403).end();
      return;
    }
    // Resolving the caller talks to GitHub and to the rate limiter, either of
    // which can throw. Uncaught, that leaves the function with no response and
    // the platform answers 500, which names no cause -- and trymerge reads any
    // failure of this endpoint as "no classifications", so it degrades quietly.
    // Answer a status that says which half failed.
    try {
      // Check if they exceed the rate limit
      const userOctokit = await getOctokitWithUserToken(
        authorization as string
      );
      const user = await userOctokit.rest.users.getAuthenticated();
      if (await drCIRateLimitExceeded(user.data.login)) {
        res.status(429).end();
        return;
      }
      // This insert IS the per-user limit, so a failed one must refuse rather
      // than serve: reads and writes use separate ClickHouse credentials, so a
      // lost INSERT permission can persist while the read above keeps
      // answering, and every authenticated user would drive unbounded work
      // under the service's own bot credentials without consuming quota. The
      // bot-key path never reaches this limiter, so refusing here does not
      // touch the scheduled comment updates.
      await incrementDrCIRateLimit(user.data.login);
    } catch (error) {
      // Only GitHub saying the credential is bad is an auth failure. A
      // ClickHouse or network fault means this endpoint could not reach its
      // dependencies, which is ours, not the caller's. Messages are fixed --
      // dependency exception text can name backends, hosts and queries -- and
      // the detail stays in the server log.
      if ((error as { status?: number }).status === 401) {
        console.error("Dr.CI rejected the caller's credential:", error);
        res.setHeader("WWW-Authenticate", "Bearer");
        res.status(401).json({ error: "Invalid credentials" } as any);
      } else {
        console.error("Dr.CI could not resolve the caller:", error);
        res
          .status(503)
          .json({ error: "Authentication service unavailable" } as any);
      }
      return;
    }
  } else {
    // No authorization provided, return 403
    res.status(403).end();
    return;
  }

  const { prNumber } = req.query;
  const { repo, org }: UpdateCommentBody = req.body;

  try {
    const validatedOrg = validateOrg(org);
    const octokit = await getOctokit(validatedOrg, repo);

    const failures = await updateDrciComments(
      octokit,
      validatedOrg,
      repo,
      prNumber ? [parseInt(prNumber as string)] : []
    );

    // Reactions don't trigger webhooks, so the scheduled run also checks
    // whether triaged PRs are ready to be marked in progress
    if (
      authorization == process.env.DRCI_BOT_KEY &&
      prNumber === undefined &&
      isPyTorchPyTorch(validatedOrg, repo)
    ) {
      try {
        await updateInProgressLabels(octokit, validatedOrg, repo);
      } catch (error) {
        console.error("Failed to update in progress labels:", error);
      }
    }
    return res.status(200).json(failures);
  } catch (error) {
    console.error("Error in Dr.CI handler:", error);
    res.status(400).json({ error: (error as Error).message } as any);
    return;
  }
}

export async function updateDrciComments(
  octokit: Octokit,
  owner: string = "pytorch",
  repo: string = "pytorch",
  prNumbers: number[]
): Promise<{ [pr: number]: { [cat: string]: RecentWorkflowsData[] } }> {
  // Fetch in two separate queries because combining into one query took much
  // longer to run on CH
  const [recentWorkflows, workflowsFromPendingComments] = await Promise.all([
    fetchRecentWorkflows(`${owner}/${repo}`, prNumbers, NUM_MINUTES + ""),
    // Only fetch if we are not updating a specific PR
    prNumbers.length != 0
      ? []
      : fetchRecentWorkflows(
          `${owner}/${repo}`,
          await getPRsNeedingCommentRefresh(`${owner}/${repo}`),
          NUM_MINUTES + ""
        ),
  ]);

  const workflowsByPR = await reorganizeWorkflows(
    owner,
    repo,
    recentWorkflows.concat(workflowsFromPendingComments),
    octokit
  );
  const existingDrCiComments = await getExistingDrCiComments(
    `${owner}/${repo}`,
    workflowsByPR
  );
  let coverage: CiflowCoverage;
  try {
    coverage = await getCiflowCoverage(
      octokit,
      owner,
      repo,
      workflowsByPR,
      existingDrCiComments,
      prNumbers.length === 0
    );
  } catch (e) {
    console.error("ciflow coverage threw for", owner, repo, e);
    coverage = { ...emptyCiflowCoverage(), stepFailed: true };
  }

  // The Green Light verdict is per-PR, not per-job, so it is read for the whole
  // sweep in one batched query. This must stay outside forAllPRs, which fans out
  // concurrently and would multiply the query by the PR count. It needs nothing
  // but the PR set, their heads and the octokit, all settled here, so it is
  // started now and awaited after the serial chain below instead of adding its
  // latency to it -- that chain is on the critical path of every on-demand poke
  // render. The catch is attached at creation, not at the await, so a rejection
  // landing before then is never an unhandled one; failing to an empty map keeps
  // a greenlight / ClickHouse error from breaking the comment.
  const headShaByPr = new Map<number, string>(
    Array.from(workflowsByPR.entries()).map(([prNumber, pr_info]) => [
      prNumber,
      pr_info.head_sha,
    ])
  );
  const greenlightSectionsPromise = buildGreenlightSections(
    owner,
    repo,
    headShaByPr,
    octokit
  ).catch((e) => {
    console.error("greenlight section build threw for", owner, repo, e);
    return new Map<number, string>();
  });
  // The automated PR review verdict is per-PR too, read the same way.
  const prReviewSectionsPromise = buildPrReviewSections(
    owner,
    repo,
    headShaByPr
  ).catch((e) => {
    console.error("pr review section build threw for", owner, repo, e);
    return new Map<number, string>();
  });
  // Read only for pytorch/pytorch. Empty otherwise or on error, which
  // promotes nothing.
  const prReviewHeadVerdictsPromise = (
    isPyTorchPyTorch(owner, repo)
      ? fetchPrReviewHeadVerdicts(owner, repo, headShaByPr)
      : Promise.resolve(new Map<number, PrReviewHeadVerdictRow>())
  ).catch((e) => {
    console.error("pr review head verdict read threw for", owner, repo, e);
    return new Map<number, PrReviewHeadVerdictRow>();
  });
  // Used to gate which CRCR L3 results are PR-visible (see classifyCrcrJobs)
  // by the same ciflow/crcr/<device> label the relay itself requires before
  // creating an upstream check run. Started early alongside the greenlight
  // fetch; a failure here degrades to "show no CRCR L3 results" rather than
  // breaking the whole comment.
  const crcrAllowlistPromise = fetchCrcrAllowlist(octokit).catch((e) => {
    console.error("CRCR allowlist fetch failed for", owner, repo, e);
    return null;
  });

  const head = get_head_branch(repo);
  await addMergeBaseCommits(octokit, owner, repo, head, workflowsByPR);
  const sevs = getActiveSEVs(
    await fetchIssuesByLabel("ci: sev", /*cache*/ true)
  );
  const flakyRules: FlakyRule[] = (await fetchJSON(FLAKY_RULES_JSON)) || [];
  const unstableIssues: IssueData[] = await fetchIssuesByLabel(
    "unstable",
    /*cache*/ true
  );
  const disabledTestIssues: IssueData[] = await fetchIssuesByLabel(
    "skipped",
    /*cache*/ true
  );
  const baseCommitJobs = await getBaseCommitJobs(workflowsByPR);
  const baseCommitJobNames = await getBaseCommitJobNames(workflowsByPR);
  const prMergeCommits = await getPRMergeCommits(
    owner,
    repo,
    Array.from(workflowsByPR.keys())
  );

  const greenlightSections = await greenlightSectionsPromise;
  const prReviewSections = await prReviewSectionsPromise;
  const prReviewHeadVerdicts = await prReviewHeadVerdictsPromise;
  const crcrAllowlist = await crcrAllowlistPromise;

  // Memoized per PR, so a PR's render can read the classification of the PRs
  // above it that cover it. A render awaits other PRs' classifications, never
  // their renders, so no two PRs can wait on each other. newAndUnclassified is
  // copied here because the render later moves jobs out of failedJobs and
  // unknownJobs (AI suppression) and pushes CRCR jobs into failedJobs.
  const getClassification = _.memoize(
    async (pr_info: PRandJobs) => {
      const labels = await fetchPRLabels(
        pr_info.owner,
        pr_info.repo,
        pr_info.pr_number
      );
      // Find the merge commits of the PR to check if it has already been merged before
      const mergeCommits = prMergeCommits.get(pr_info.pr_number) || [];
      const statuses = await getWorkflowJobsStatuses(
        pr_info,
        flakyRules,
        baseCommitJobs.get(pr_info.merge_base) || new Map(),
        labels || [],
        unstableIssues || [],
        disabledTestIssues || [],
        mergeCommits || [],
        baseCommitJobNames.get(pr_info.merge_base)
      );
      return {
        labels,
        ...statuses,
        newAndUnclassified: [...statuses.failedJobs, ...statuses.unknownJobs],
      };
    },
    (pr_info: PRandJobs) => pr_info.pr_number
  );

  // Return the list of all failed jobs grouped by their classification
  const failures: { [pr: number]: { [cat: string]: RecentWorkflowsData[] } } =
    {};

  await forAllPRs(
    workflowsByPR,
    async (pr_info: PRandJobs) => {
      const {
        labels,
        pending,
        failedJobs,
        flakyJobs,
        brokenTrunkJobs,
        unstableJobs,
        unknownJobs,
        awaitingApprovalJobs,
        relatedJobs,
        relatedIssues,
        relatedInfo,
        newAndUnclassified,
      } = await getClassification(pr_info);

      failures[pr_info.pr_number] = {
        FAILED: failedJobs,
        FLAKY: flakyJobs,
        BROKEN_TRUNK: brokenTrunkJobs,
        UNSTABLE: unstableJobs,
        UNKNOWN: unknownJobs,
        AWAITING_APPROVAL: awaitingApprovalJobs,
      };

      try {
        addCoveredCiflowNotes(
          owner,
          repo,
          pr_info.pr_number,
          newAndUnclassified,
          relatedInfo,
          coverage.coversBelow.get(pr_info.pr_number)
        );
      } catch (e) {
        console.error(
          "covered ciflow note build threw for PR",
          pr_info.pr_number,
          e
        );
      }

      // The failures either advisor consumer can say anything about. PR-state
      // gates are left out, so no verdict line renders beside one.
      const advisorJobs = [...failedJobs, ...unknownJobs].filter(
        (job) => !isExcludedFromAdvisor(job)
      );

      // One read of this PR's advisor verdicts, shared by auto-dispatch, the
      // inline "AI verdict:" line and the suppression gate below. Reading per
      // consumer would let a verdict landing between the reads make the badge
      // and the merge gate describe the same job differently.
      //
      // A read that is skipped or fails yields an empty array, which every
      // consumer treats as "no verdict": nothing is suppressed and no rerun is
      // re-dispatched, so every job keeps blocking. The comment can still
      // render an "analyzing" line for a job with a dispatch in flight, since
      // that state is read separately below.
      let advisorVerdictRows: AdvisorVerdictRow[] = [];
      if (shouldReadAdvisorVerdicts(owner, repo, advisorJobs)) {
        try {
          advisorVerdictRows = await fetchAdvisorVerdictRows(
            owner,
            repo,
            pr_info.pr_number
          );
        } catch (e) {
          console.error(
            "advisor verdict fetch threw for PR",
            pr_info.pr_number,
            e
          );
        }
      }

      // Auto-dispatch the AI CI Advisor on NEW + UNCLASSIFIED failures. Both are
      // PR failures the advisor can usefully analyze: unknownJobs (Unclassified)
      // are failures whose job did not run on the merge base, so Dr.CI has no
      // same-job baseline -- but the advisor builds its own recent-trunk baseline
      // by job-name pattern, so it still has signal. They're passed as one list
      // so the maxNewFailures outage guard bounds the combined per-PR fan-out
      // (Unclassified were historically part of the new-failure bucket; splitting
      // them in the Dr.CI comment was only to reduce comment noise). No-op unless
      // the feature flag + production env + per-repo config are all set; dispatch
      // only (no comment/merge changes), with its own ClickHouse dedup + outage
      // guard. It reads the verdict rows above only to decide whether a job
      // rerun at this head can be re-analyzed. Wrapped so an advisor error can
      // never break the comment.
      try {
        await autoDispatchAdvisorForNewFailures({
          owner,
          repo,
          prNumber: pr_info.pr_number,
          headSha: pr_info.head_sha,
          mergeBaseSha: pr_info.merge_base,
          newFailures: [...failedJobs, ...unknownJobs],
          verdictRows: advisorVerdictRows,
        });
      } catch (e) {
        console.error(
          "advisor auto-dispatch threw for PR",
          pr_info.pr_number,
          e
        );
      }

      // The latest dispatch per job, read AFTER auto-dispatch so a dispatch it
      // just made is seen. Shared by the verdict line and the suppression gate,
      // which both count a verdict only if it answers a dispatch made after the
      // job's run finished. A failed read yields null: no verdict then covers
      // its run, so every job keeps blocking, and every line for a job whose
      // completion time is known shows the pending sentinel so the next sweep
      // re-renders the PR (see selectAdvisorLines).
      let advisorDispatches: Map<string, DispatchMark> | null = new Map();
      if (shouldReadAdvisorVerdicts(owner, repo, advisorJobs)) {
        try {
          const states = await readDispatchStates(
            owner,
            repo,
            pr_info.head_sha,
            advisorJobs
              .filter((j) => j.name)
              .map((j) => signalKeyForJob(j.name))
          );
          advisorDispatches = new Map(
            Array.from(states, ([key, st]) => [key, toDispatchMark(st)])
          );
        } catch (e) {
          advisorDispatches = null;
          console.error(
            "advisor dispatch-state read threw for PR",
            pr_info.pr_number,
            e
          );
        }
      }

      // Render the verdicts for this PR's new and unclassified failures as an
      // inline line per job. Wrapped so an advisor error can never break the
      // comment.
      let advisorLines: Map<number, string> = new Map();
      try {
        advisorLines = buildAdvisorVerdictLines(
          HUD_URL,
          owner,
          repo,
          pr_info.pr_number,
          pr_info.head_sha,
          advisorJobs,
          advisorVerdictRows,
          advisorDispatches,
          autoDispatchEnabled(owner, repo)
        );
      } catch (e) {
        console.error(
          "advisor verdict-line build threw for PR",
          pr_info.pr_number,
          e
        );
      }

      // Move failures the advisor cleared as `not_related` into their own
      // bucket, so they leave the NEW/UNCLASSIFIED sections and stop blocking
      // the merge. Runs BEFORE the CRCR block below on purpose: CRCR L4 jobs
      // are pushed into failedJobs there and were never advisor-analyzed, so
      // they must not be eligible. Wrapped so an unexpected error can never
      // break the comment -- and failing to an empty set keeps everything
      // blocking, which is the safe direction.
      const aiNotRelatedJobs: RecentWorkflowsData[] = [];
      try {
        const suppressible = suppressibleJobIds(
          owner,
          repo,
          pr_info.head_sha,
          advisorJobs,
          advisorVerdictRows,
          advisorDispatches ?? new Map()
        );
        aiNotRelatedJobs.push(
          ...extractSuppressed(failedJobs, suppressible),
          ...extractSuppressed(unknownJobs, suppressible)
        );
      } catch (e) {
        console.error(
          "advisor suppression lookup threw for PR",
          pr_info.pr_number,
          e
        );
      }

      if (aiNotRelatedJobs.length > 0) {
        failures[pr_info.pr_number].AI_NOT_RELATED = aiNotRelatedJobs;
      }

      // Classify CRCR downstream CI jobs (L3 = non-blocking, L4 = blocking).
      // These jobs live in oot_workflow_job, not workflow_job, so they are fetched
      // separately and classified based on their downstream_repo_level.
      let crcrL3Jobs: RecentWorkflowsData[] = [];
      try {
        const crcrWorkflows = await fetchCrcrWorkflows(`${owner}/${repo}`, [
          pr_info.pr_number,
        ]);
        const classified = classifyCrcrJobs(
          crcrWorkflows,
          labels || [],
          crcrAllowlist
        );
        crcrL3Jobs = classified.crcrL3Jobs;
        // L4 failures are blocking — merge them into failedJobs
        failedJobs.push(...classified.crcrL4Jobs);
      } catch (err) {
        // If CRCR fetch fails, log and proceed — don't block the Dr.CI update
        console.error("Failed to fetch CRCR workflows:", err);
      }

      if (crcrL3Jobs.length > 0) {
        failures[pr_info.pr_number].CRCR_L3 = crcrL3Jobs;
      }

      const coverFailures = await Promise.all(
        (coverage.coveredBy.get(pr_info.pr_number) ?? []).map(
          async ({ cover, label }) => {
            try {
              const { newAndUnclassified } = await getClassification(
                workflowsByPR.get(cover)!
              );
              return { cover, label, failures: newAndUnclassified };
            } catch (e) {
              console.error(
                "classification of PR",
                cover,
                "above PR",
                pr_info.pr_number,
                "threw",
                e
              );
              return { cover, label, failures: null };
            }
          }
        )
      );
      const oldComment =
        existingDrCiComments.get(pr_info.pr_number) ||
        (await getDrciComment(octokit, owner, repo, pr_info.pr_number));
      const failuresAbove = renderFailuresAbove(
        HUD_URL,
        owner,
        repo,
        {
          headSha: pr_info.head_sha,
          labels: labels || [],
          comment: oldComment.body,
        },
        coverFailures,
        (cover) =>
          !coverage.noLabelerConfig &&
          (coverage.stepFailed ||
            coverage.failed.has(cover) ||
            !workflowsByPR.has(cover))
      );

      const failureInfo = constructResultsComment(
        pending,
        failedJobs,
        flakyJobs,
        brokenTrunkJobs,
        unstableJobs,
        unknownJobs,
        awaitingApprovalJobs,
        crcrL3Jobs,
        aiNotRelatedJobs,
        relatedJobs,
        relatedIssues,
        relatedInfo,
        pr_info.head_sha,
        pr_info.merge_base,
        pr_info.merge_base_date,
        HUD_URL,
        owner,
        repo,
        pr_info.pr_number,
        advisorLines,
        greenlightSections.get(pr_info.pr_number) ?? "",
        failuresAbove
      );

      // Runs before the PR status section below so it renders the new stage.
      const review = prReviewHeadVerdicts.get(pr_info.pr_number);
      let promotion: PromotionOutcome = "not_eligible";
      if (review !== undefined) {
        try {
          promotion = await maybePromoteToReadyForReview(
            octokit,
            owner,
            repo,
            pr_info.pr_number,
            pr_info.head_sha,
            review,
            isCiGoodForReview({
              pending,
              failedJobs,
              unknownJobs,
              awaitingApprovalJobs,
            })
          );
        } catch (e) {
          console.error(
            "ready for review promotion threw for PR",
            pr_info.pr_number,
            e
          );
        }
      }

      // Use live labels so a lagging ClickHouse snapshot cannot overwrite a
      // newer webhook update. Mirrored labels and an existing section only gate
      // the GitHub read; live labels determine what renders. On an API failure,
      // preserve the existing section and let a later update retry.
      let prStatusSection = "";
      if (isPyTorchPyTorch(owner, repo)) {
        const existingComment =
          existingDrCiComments.get(pr_info.pr_number)?.body ?? "";
        prStatusSection = extractPrStatusSection(existingComment);
        try {
          if (
            hasPrStatusLabel(labels || []) ||
            existingComment.includes(PR_STATUS_START)
          ) {
            const liveLabels = await fetchLiveLabels(
              octokit,
              owner,
              repo,
              pr_info.pr_number
            );

            if (hasPrStatusLabel(liveLabels)) {
              const state = await fetchPrStatusState(
                octokit,
                owner,
                repo,
                pr_info.pr_number,
                liveLabels
              );
              if (state !== null) {
                prStatusSection = renderPrStatusSection(state);
              }
            } else {
              prStatusSection = "";
            }
          }
        } catch (e) {
          console.error("PR status build threw for PR", pr_info.pr_number, e);
        }
      }

      const comment = formDrciComment(
        pr_info.pr_number,
        owner,
        repo,
        failureInfo,
        formDrciSevBody(sevs),
        prStatusSection,
        pr_info.headRef,
        labels,
        withStaleReviewNote(
          prReviewSections.get(pr_info.pr_number) ?? "",
          promotion
        )
      );

      const { id, body } = oldComment;

      // The comment is there and remains unchanged, so there is no need to do anything
      if (body === comment) {
        return;
      }

      // If the id is 0, it means that the bot has failed to create the comment, so we
      // are free to create a new one here
      if (id === 0) {
        await octokit.rest.issues.createComment({
          body: comment,
          owner: owner,
          repo: repo,
          issue_number: pr_info.pr_number,
        });
      }
      // Otherwise, update the existing comment
      else {
        await octokit.rest.issues.updateComment({
          body: comment,
          owner: owner,
          repo: repo,
          comment_id: id,
        });
      }

      // Also update the check run status. As this is run under pytorch-bot,
      // the check run will show up under that GitHub app
      await octokit.rest.checks.create({
        owner: owner,
        repo: repo,
        name: "Dr.CI",
        head_sha: pr_info.head_sha,
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "Dr.CI classification results",
          // NB: the summary contains the classification result from Dr.CI,
          // so that it can be queried elsewhere
          summary: JSON.stringify(
            removeFailureContext(failures[pr_info.pr_number])
          ),
        },
      });
    },
    async (pr_info: PRandJobs, e: Error) => {
      console.log("Failed to update PR", pr_info.pr_number, e);
    }
  );

  return failures;
}

/**
 * Changes the failure context of each job to an empty array. This is done to
 * reduce the size of the payload, which can some times exceed the maximum size
 * allowed by GitHub
 * @param failure
 * @returns
 */
function removeFailureContext(failure: {
  [cat: string]: RecentWorkflowsData[];
}) {
  const result = { ...failure };
  for (const cat in result) {
    result[cat] = result[cat].map((job) => {
      return { ...job, failure_context: [] };
    });
  }
  return result;
}

const MAX_COVERED_PRS_IN_NOTE = 10;
const MAX_FAILURES_ABOVE_PER_SECTION = 10;
const MAX_FAILURES_ABOVE_SECTIONS = 3;
const CIFLOW_COVERAGE_BUDGET_MS = 120_000;
const CIFLOW_LABEL_PATTERN = "ciflow/[A-Za-z0-9._/-]+";
const CIFLOW_LABEL_RE = new RegExp(`^${CIFLOW_LABEL_PATTERN}$`);
const CIFLOW_ABOVE_END = "<!-- drci-ciflow-above-end -->";
const CIFLOW_ABOVE_BLOCK_RE = new RegExp(
  `^<!-- drci-ciflow-above ([1-9][0-9]{0,9}) (${CIFLOW_LABEL_PATTERN}) ([0-9a-f]{40}) ([1-9][0-9]{0,9}) -->\\n[\\s\\S]*?\\n${_.escapeRegExp(
    CIFLOW_ABOVE_END
  )}$`,
  "gm"
);
const CODE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_CODE_FENCE_RE = /^ {0,3}(`{3,}|~{3,}) *$/;

function redirectPrUrl(owner: string, repo: string, prNumber: number): string {
  return `https://redirect.github.com/${owner}/${repo}/pull/${prNumber}`;
}

function ciflowAboveKey(cover: number, label: string): string {
  return `${cover} ${label}`;
}

// Dr.CI embeds untrusted text in its comment: job names and log captures,
// which never start a line; the Green Light and PR review texts, as whole
// lines inside fences or HTML-escaped; and AI advisor summaries, escaped but
// able to start a line with a fence. So a block counts only when its start
// line is outside every fenced region. Fenced lines are blanked before the
// match, so a start marker inside a fence cannot run on into a real block.
function parseCiflowAboveBlocks(comment: string | undefined) {
  let fence: string | undefined;
  const unfenced = (comment ?? "")
    .split("\n")
    .map((line) => {
      if (fence === undefined) {
        fence = line.match(CODE_FENCE_RE)?.[1];
        return fence === undefined ? line : "";
      }
      const closing = line.match(CLOSING_CODE_FENCE_RE)?.[1];
      if (closing?.[0] === fence[0] && closing.length >= fence.length) {
        fence = undefined;
      }
      return "";
    })
    .join("\n");
  return _.uniqBy(
    Array.from(unfenced.matchAll(CIFLOW_ABOVE_BLOCK_RE), (match) => ({
      cover: parseInt(match[1]),
      label: match[2],
      sha: match[3],
      count: parseInt(match[4]),
      text: match[0],
    })),
    ({ cover, label }) => ciflowAboveKey(cover, label)
  );
}

/**
 * The ciflow label of a job of this PR's tag run: a tag push records the tag,
 * `<label>/<PR number>`, as the job's head_branch.
 */
function getCiflowTagLabel(
  headBranch: string | null | undefined,
  prNumber: number
): string | undefined {
  const suffix = `/${prNumber}`;
  if (!headBranch?.endsWith(suffix)) {
    return undefined;
  }
  const label = headBranch.slice(0, -suffix.length);
  return label.startsWith("ciflow/") ? label : undefined;
}

function isConfigCiflowLabel(
  labelerConfig: Record<string, unknown>,
  label: string
): boolean {
  return label.startsWith("ciflow/") && Object.hasOwn(labelerConfig, label);
}

function isFailedOrCancelled(job: RecentWorkflowsData): boolean {
  return job.conclusion === "failure" || job.conclusion === "cancelled";
}

/**
 * The PRs a run of a ciflow label covers among the open PRs below its PR in
 * the stack, nearest first: the ones that need the label, down to the nearest
 * one that carries it, whose own run covers the PRs below it.
 */
function getCoveredPrs(
  below: StackPr[],
  label: string,
  labelerConfig: Record<string, unknown>
): number[] {
  const covered: number[] = [];
  for (const p of below) {
    if (p.labels.includes(label)) {
      break;
    }
    if (
      getLabelsNeededByFiles(labelerConfig, p.files, p.isDraft).includes(label)
    ) {
      covered.push(p.number);
    }
  }
  return covered;
}

/**
 * For each labeler-config ciflow label the cover carries, the open PRs below
 * it in its stack that the label's run on it covers. Labels that cover no PR
 * are left out.
 */
async function walkCiflowCover(
  octokit: Octokit,
  owner: string,
  repo: string,
  cover: number,
  labelerConfig: Record<string, unknown>
): Promise<Map<string, number[]>> {
  const coveredByLabel = new Map<string, number[]>();
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: cover,
  });
  const labels = pr.labels
    .map((label) => label.name)
    .filter((label) => isConfigCiflowLabel(labelerConfig, label));
  if (labels.length === 0) {
    return coveredByLabel;
  }
  const below = await getOpenStackPrs(
    octokit,
    owner,
    repo,
    {
      number: cover,
      body: pr.body,
      headRef: pr.head.ref,
      isCrossRepository: pr.head.repo?.full_name !== pr.base.repo.full_name,
      stack: (pr as any).stack,
    },
    "below"
  );
  if (below.kind !== "stack") {
    return coveredByLabel;
  }
  for (const label of labels) {
    const covered = getCoveredPrs(below.prs, label, labelerConfig);
    if (covered.length > 0) {
      coveredByLabel.set(label, covered);
    }
  }
  return coveredByLabel;
}

/**
 * The open PRs among prNumbers, each with every job at its current head, and
 * their Dr.CI comments.
 */
async function fetchCoveragePrs(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumbers: number[]
): Promise<{
  prs: Map<number, PRandJobs>;
  comments: Map<number, { id: number; body: string }>;
}> {
  const wanted = new Set(prNumbers);
  const rows = await fetchRecentWorkflows(
    `${owner}/${repo}`,
    prNumbers,
    NUM_MINUTES + ""
  );
  // The query also returns the other open PRs that share a requested head SHA.
  const prs = await reorganizeWorkflows(
    owner,
    repo,
    rows.filter((row) => wanted.has(row.pr_number)),
    octokit
  );
  return {
    prs,
    comments:
      prs.size === 0
        ? new Map()
        : await getExistingDrCiComments(`${owner}/${repo}`, prs),
  };
}

export interface CiflowCoverage {
  coversBelow: Map<number, Map<string, number[]>>;
  coveredBy: Map<number, { cover: number; label: string }[]>;
  walked: Set<number>;
  failed: Set<number>;
  stepFailed: boolean;
  noLabelerConfig: boolean;
}

function emptyCiflowCoverage(): CiflowCoverage {
  return {
    coversBelow: new Map(),
    coveredBy: new Map(),
    walked: new Set(),
    failed: new Set(),
    stepFailed: false,
    noLabelerConfig: false,
  };
}

/**
 * Which PRs of the run cover which open PRs below them in their stacks, for
 * which ciflow labels: coversBelow maps a cover to its labels and the PRs each
 * covers, nearest first, and coveredBy maps a covered PR to its covers.
 *
 * A PR of the run is walked (see walkCiflowCover) when its own tag run of a
 * labeler-config ciflow label has a failed or cancelled job. With fanOut, the
 * PRs a walked cover covers for its failing labels, and the open PRs whose
 * comment shows a block of a PR in the run, are fetched into the run (added to
 * workflowsByPR and existingDrCiComments), and the covers among them are
 * walked without fanning out. Work not done within budgetMs counts as failed:
 * octokit waits out an exhausted rate limit, which can outlast the function.
 */
export async function getCiflowCoverage(
  octokit: Octokit,
  owner: string,
  repo: string,
  workflowsByPR: Map<number, PRandJobs>,
  existingDrCiComments: Map<number, { id: number; body: string }>,
  fanOut: boolean,
  budgetMs: number = CIFLOW_COVERAGE_BUDGET_MS
): Promise<CiflowCoverage> {
  const coverage = emptyCiflowCoverage();
  const runPrs = new Set(workflowsByPR.keys());
  const failingTagRunLabels = (pr: PRandJobs) =>
    new Set(
      pr.jobs
        .filter(isFailedOrCancelled)
        .map((job) => getCiflowTagLabel(job.head_branch, pr.pr_number))
        .filter((label): label is string => label !== undefined)
    );
  const hasFailingTagRun = Array.from(workflowsByPR.values()).some(
    (pr) => failingTagRunLabels(pr).size > 0
  );
  if (!hasFailingTagRun && !fanOut) {
    return coverage;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), budgetMs);
  });
  const withinBudget = async <T>(work: Promise<T>, what: string) => {
    const result = await Promise.race([
      work.then((value) => ({ value })),
      expired,
    ]);
    if (result === "expired") {
      throw new Error(`${what} did not finish within ${budgetMs} ms`);
    }
    return result.value;
  };
  try {
    const blockTargets: Promise<number[]> = fanOut
      ? withinBudget(
          getPRsShowingCiflowAbove(`${owner}/${repo}`),
          "looking up the PRs that show a run above"
        )
          .then((rows) =>
            rows
              .filter(
                ({ prNumber, body }) =>
                  !runPrs.has(prNumber) &&
                  parseCiflowAboveBlocks(body).some(({ cover }) =>
                    runPrs.has(cover)
                  )
              )
              .map(({ prNumber }) => prNumber)
          )
          .catch((e) => {
            console.error(
              "could not look up the PRs that show a ciflow run above in",
              owner,
              repo,
              e
            );
            return [];
          })
      : Promise.resolve([]);
    if (!hasFailingTagRun && (await blockTargets).length === 0) {
      return coverage;
    }

    let labelerConfig: Record<string, unknown> | null;
    try {
      labelerConfig = await withinBudget(
        loadLabelerConfig(octokit, owner, repo),
        "reading the labeler config"
      );
    } catch (e) {
      console.error(
        "could not read the labeler config of",
        owner,
        repo,
        "for ciflow coverage",
        e
      );
      return { ...coverage, stepFailed: true };
    }
    if (labelerConfig === null) {
      return { ...coverage, noLabelerConfig: true };
    }
    const config = labelerConfig;
    const walkCovers = (prs: PRandJobs[]) =>
      Promise.all(
        prs
          .filter((pr) =>
            Array.from(failingTagRunLabels(pr)).some((label) =>
              isConfigCiflowLabel(config, label)
            )
          )
          .map(async ({ pr_number: cover }) => {
            try {
              const coveredByLabel = await withinBudget(
                walkCiflowCover(octokit, owner, repo, cover, config),
                `the walk of PR ${cover}`
              );
              coverage.walked.add(cover);
              if (coveredByLabel.size > 0) {
                coverage.coversBelow.set(cover, coveredByLabel);
              }
              coveredByLabel.forEach((covered, label) =>
                covered.forEach((prNumber) =>
                  coverage.coveredBy.set(prNumber, [
                    ...(coverage.coveredBy.get(prNumber) ?? []),
                    { cover, label },
                  ])
                )
              );
            } catch (e) {
              console.error(
                "could not read the stack below PR",
                cover,
                "for ciflow coverage",
                e
              );
              coverage.failed.add(cover);
            }
          })
      );

    await walkCovers(Array.from(workflowsByPR.values()));
    if (!fanOut) {
      return coverage;
    }
    const walkTargets = Array.from(coverage.walked).flatMap((cover) => {
      const failing = failingTagRunLabels(workflowsByPR.get(cover)!);
      return Array.from(coverage.coversBelow.get(cover) ?? [])
        .filter(([label]) => failing.has(label))
        .flatMap(([, prs]) => prs);
    });
    const wanted = _.uniq([...walkTargets, ...(await blockTargets)]).filter(
      (prNumber) => !workflowsByPR.has(prNumber)
    );
    let added = new Map<number, PRandJobs>();
    if (wanted.length > 0) {
      try {
        const { prs, comments } = await withinBudget(
          fetchCoveragePrs(octokit, owner, repo, wanted),
          "fetching the covered PRs"
        );
        prs.forEach((pr, prNumber) => workflowsByPR.set(prNumber, pr));
        comments.forEach((comment, prNumber) =>
          existingDrCiComments.set(prNumber, comment)
        );
        added = prs;
      } catch (e) {
        console.error("could not fetch PRs", wanted, "for ciflow coverage", e);
      }
    }
    await walkCovers(Array.from(added.values()));
    return coverage;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Notes, on one failing job of each ciflow label's tag run on this PR, the
 * open PRs below it in its stack that the run covers (from getCiflowCoverage):
 * the run tests them too, so the failure may come from one of them. The PRs
 * are linked through redirect.github.com so the comment adds no
 * cross-references to them.
 */
export function addCoveredCiflowNotes(
  owner: string,
  repo: string,
  prNumber: number,
  failures: RecentWorkflowsData[],
  relatedInfo: Map<number, string>,
  coveredByLabel: Map<string, number[]> | undefined
): void {
  const failuresByLabel = new Map<string, RecentWorkflowsData[]>();
  for (const job of failures) {
    const label = getCiflowTagLabel(job.head_branch, prNumber);
    if (label !== undefined) {
      failuresByLabel.set(label, [...(failuresByLabel.get(label) ?? []), job]);
    }
  }

  for (const [label, jobs] of failuresByLabel) {
    const covered = coveredByLabel?.get(label) ?? [];
    if (covered.length === 0) {
      continue;
    }
    const links = covered
      .slice(0, MAX_COVERED_PRS_IN_NOTE)
      .map((n) => `[${n}](${redirectPrUrl(owner, repo, n)})`)
      .join(", ");
    const more =
      covered.length > MAX_COVERED_PRS_IN_NOTE
        ? ` and ${covered.length - MAX_COVERED_PRS_IN_NOTE} more`
        : "";
    const note =
      covered.length === 1
        ? `${label} on this PR also tests PR ${links} below it, which needs it and does not run it itself; the failure may come from that PR, which then needs the fix`
        : `${label} on this PR also tests PRs ${links}${more} below it, which need it and do not run it themselves; the failure may come from one of them, which then needs the fix`;
    const job = _.sortBy(jobs, ["name", "id"])[0];
    const existing = relatedInfo.get(job.id);
    relatedInfo.set(job.id, existing ? `${existing}; ${note}` : note);
  }
}

function renderCiflowAboveBlock(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  headSha: string,
  cover: number,
  label: string,
  jobs: RecentWorkflowsData[]
): string {
  const shown = jobs.slice(0, MAX_FAILURES_ABOVE_PER_SECTION);
  const which =
    shown.length < jobs.length
      ? `${shown.length} of ${jobs.length} jobs`
      : pluralize("job", jobs.length);
  const coverLink = `<a href="${redirectPrUrl(
    owner,
    repo,
    cover
  )}">${cover}</a>`;
  return (
    `<!-- drci-ciflow-above ${cover} ${label} ${headSha} ${jobs.length} -->` +
    constructResultsJobsSections(
      hudBaseUrl,
      owner,
      repo,
      cover,
      `${pluralize("FAILURE", jobs.length).toLocaleUpperCase()} ABOVE`,
      `This PR needs <code>${label}</code> and does not run it. PR ${coverLink} above runs it, and that run also tests this PR. The following ${which} did not pass there; the cause may be in this PR, in PR ${cover} or in a PR between them`,
      shown
    ) +
    `\n${CIFLOW_ABOVE_END}`
  );
}

/**
 * The sections, on a lower PR, for the failing runs of its covers above: a
 * fresh one for each cover and label whose classification resolved in this run
 * (failures is null when it did not), then the blocks kept from the PR's
 * comment, at most MAX_FAILURES_ABOVE_SECTIONS of them shown. isUnresolved
 * says whether this run could not look a cover up. count is the number of
 * failures of every block, shown or not.
 */
export function renderFailuresAbove(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  lowerPr: { headSha: string; labels: string[]; comment: string | undefined },
  covers: {
    cover: number;
    label: string;
    failures: RecentWorkflowsData[] | null;
  }[],
  isUnresolved: (_cover: number) => boolean
): { sections: string; count: number } {
  const decided = new Set<string>();
  const unclassified = new Set<number>();
  const fresh: { count: number; text: string }[] = [];
  for (const { cover, label, failures } of _.sortBy(covers, [
    "cover",
    "label",
  ])) {
    if (failures === null) {
      unclassified.add(cover);
      continue;
    }
    decided.add(ciflowAboveKey(cover, label));
    const jobs = _.sortBy(
      failures.filter(
        (job) => getCiflowTagLabel(job.head_branch, cover) === label
      ),
      ["name", "id"]
    );
    if (jobs.length > 0 && CIFLOW_LABEL_RE.test(label)) {
      fresh.push({
        count: jobs.length,
        text: renderCiflowAboveBlock(
          hudBaseUrl,
          owner,
          repo,
          lowerPr.headSha,
          cover,
          label,
          jobs
        ),
      });
    }
  }
  // A block survives only while this run could not look its cover up, so a
  // failed walk or classification, or a run without the cover, never turns
  // this PR green. A new head or the label on this PR ends it either way: the
  // run above then no longer tests this PR's changes in its place.
  const carried = _.sortBy(
    parseCiflowAboveBlocks(lowerPr.comment).filter(
      (block) =>
        !decided.has(ciflowAboveKey(block.cover, block.label)) &&
        (unclassified.has(block.cover) || isUnresolved(block.cover)) &&
        block.sha === lowerPr.headSha &&
        !lowerPr.labels.includes(block.label)
    ),
    ["cover", "label"]
  );
  const blocks = [...fresh, ...carried];
  const hidden = blocks.length - MAX_FAILURES_ABOVE_SECTIONS;
  const notShown =
    hidden > 0
      ? `\n<p>${hidden} more failing ${pluralize(
          "run",
          hidden
        )} above ${pluralize("is", hidden, "are")} not shown.</p>`
      : "";
  return {
    sections:
      blocks
        .slice(0, MAX_FAILURES_ABOVE_SECTIONS)
        .map(({ text }) => `\n${text}`)
        .join("") + notShown,
    count: _.sumBy(blocks, "count"),
  };
}

/**
 * Returns a list of PR numbers whose Dr. CI comment still renders an in-progress
 * state, so it warrants a re-render even if nothing else woke the sweep. Used for
 * getting a list of PRs to backfill ex if Dr. CI fails to update the comment
 * due to an error
 * @param repo The repository to search for PRs in. E.g. "pytorch/pytorch"
 * @returns A list of PR numbers
 */
// PRs whose Dr.CI comment is in a transient state that warrants a re-render
// even with no recent (< NUM_MINUTES) workflow activity. Four cases:
//   - `\d Pending`: the comment still shows pending jobs that may resolve.
//   - the advisor pending sentinel: a NEW/unclassified failure was dispatched
//     to the AI advisor but its verdict had not landed at the last render, so
//     the comment carries the in-progress `alt="AI verdict: pending"` line. The
//     verdict can land seconds after a render and the PR's CI then go quiet,
//     so without this clause the concluded <details> expand would never get
//     written. Once the verdict renders, the alt becomes `AI verdict: <label>`
//     (no "pending"), so the PR self-clears from this set. We match the full
//     alt attribute (not the bare phrase) so an escaped model summary can't
//     false-match.
//   - the greenlight pending sentinel: the same problem for the PR-level Green
//     Light verdict, which also lands out of band from any workflow event. Only
//     an in-flight render emits it and every terminal one omits it, so the PR
//     self-clears the same way (see GREENLIGHT_PENDING_ALT_ATTR).
//   - the PR review pending sentinel: the same for the automated PR review
//     section (see PR_REVIEW_PENDING_ALT_ATTR).
// All four stay gated by the open-PR + 1-month freshness guards below, and by
// the comment author: the marker and the sentinels are plain text any user can
// put in a comment body, and a comment Dr.CI does not own is one it cannot
// refresh -- so without the author filter an arbitrary user could pin a PR into
// every sweep indefinitely. Qualified as issue_comment.user.login because
// pull_request carries a `user` column too.
// These predicates read the RAW body, so the author filter is not the whole
// story: the Green Light message is model output that Dr.CI embeds in its own
// comment, fenced or HTML-escaped depending on the format the row carries but in
// neither case with the matched characters removed. Every literal matched here
// therefore has to be defused on the way in -- see defuseSweepSentinels in
// lib/greenlight/greenlightSweep.ts, the one pass every one of those renderers runs
// and which any new predicate added below must also cover.
async function getPRsNeedingCommentRefresh(repo: String): Promise<number[]> {
  const query = `
select
    issue_comment.issue_url
from
    default.issue_comment final
    join default.pull_request on issue_comment.issue_url = pull_request.issue_url
where
    body like '<!-- drci-comment-start -->%'
    and issue_comment.user.login = {drciCommentAuthor: String}
    and (
        match(body, '\\d Pending')
        or position(body, {pendingAltAttr: String}) > 0
        or position(body, {greenlightPendingAltAttr: String}) > 0
        or position(body, {prReviewPendingAltAttr: String}) > 0
    )
    and issue_comment.updated_at > now() - interval 1 month
    and issue_url like {repo: String }
    and pull_request.state = 'open'
`;
  const results = await queryClickhouse(query, {
    repo: `%${repo}%`,
    drciCommentAuthor: DRCI_COMMENT_AUTHOR,
    pendingAltAttr: ADVISOR_PENDING_ALT_ATTR,
    greenlightPendingAltAttr: GREENLIGHT_PENDING_ALT_ATTR,
    prReviewPendingAltAttr: PR_REVIEW_PENDING_ALT_ATTR,
  });
  return results.map((v) => parseInt(v.issue_url.split("/").pop()));
}

/**
 * The open PRs of the repo whose Dr.CI comment has a line starting a block of
 * a failing run above (see renderCiflowAboveBlock), each with that comment,
 * under the same guards as getPRsNeedingCommentRefresh. The match is only a
 * prefilter: parseCiflowAboveBlocks decides which blocks count.
 */
async function getPRsShowingCiflowAbove(
  repo: string
): Promise<{ prNumber: number; body: string }[]> {
  const query = `
select
    issue_comment.issue_url,
    issue_comment.body
from
    default.issue_comment final
    join default.pull_request on issue_comment.issue_url = pull_request.issue_url
where
    body like '<!-- drci-comment-start -->%'
    and issue_comment.user.login = {drciCommentAuthor: String}
    and match(body, '(?m)^<!-- drci-ciflow-above [0-9]+ ')
    and issue_comment.updated_at > now() - interval 1 month
    and issue_url like {repo: String }
    and pull_request.state = 'open'
`;
  const results = await queryClickhouse(query, {
    repo: `%${repo}%`,
    drciCommentAuthor: DRCI_COMMENT_AUTHOR,
  });
  return results.map((v) => ({
    prNumber: parseInt(v.issue_url.split("/").pop()),
    body: v.body,
  }));
}

async function forAllPRs(
  workflowsByPR: Map<number, PRandJobs>,
  func: CallableFunction,
  errorFunc: CallableFunction
) {
  await Promise.all(
    Array.from(workflowsByPR.values()).map(async (pr_info) => {
      try {
        await func(pr_info);
      } catch (e) {
        await errorFunc(pr_info, e);
      }
    })
  );
}

function get_head_branch(_repo: string) {
  return "main";
}

async function addMergeBaseCommits(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  workflowsByPR: Map<number, PRandJobs>
) {
  const s3client = getS3Client();

  const chMergeBases = new Map(
    (
      await queryClickhouseSaved("merge_bases", {
        shas: Array.from(workflowsByPR.values()).map((v) => v.head_sha),
        repo: `${owner}/${repo}`,
      })
    )?.map((v) => [v.head_sha, v])
  );

  await forAllPRs(
    workflowsByPR,
    async (pr_info: PRandJobs) => {
      const chMergeBase = chMergeBases.get(pr_info.head_sha);
      if (chMergeBase === undefined) {
        // Not found on CH, ask github instead, then put into dynamo, which will
        // get synced with CH
        const diff = await octokit.rest.repos.compareCommits({
          owner: owner,
          repo: repo,
          base: pr_info.head_sha,
          head: head,
        });
        pr_info.merge_base = diff.data.merge_base_commit.sha;
        pr_info.merge_base_date =
          diff.data.merge_base_commit.commit.committer?.date ?? "";

        const diffWithMergeBase = await octokit.rest.repos.compareCommits({
          owner: owner,
          repo: repo,
          base: pr_info.merge_base,
          head: pr_info.head_sha,
        });

        try {
          const data = {
            sha: pr_info.head_sha,
            merge_base: pr_info.merge_base,
            changed_files: diffWithMergeBase.data.files?.map((e) => e.filename),
            merge_base_commit_date: pr_info.merge_base_date,
            repo: `${owner}/${repo}`,
            _id: `${owner}-${repo}-${pr_info.head_sha}`,
          };
          s3client.send(
            new PutObjectCommand({
              Bucket: "ossci-raw-job-status",
              Key: `merge_bases/${owner}/${repo}/${pr_info.head_sha}.gzip`,
              Body: JSON.stringify(data),
              ContentType: "application/json",
            })
          );
        } catch (e) {
          console.error("Failed to upload to S3", e);
        }
      } else {
        pr_info.merge_base = chMergeBase.merge_base;
        pr_info.merge_base_date = chMergeBase.merge_base_commit_date;
      }
    },
    // NB (huydhn): This function couldn't find merge base for ghstack PR and
    // always throw an error in that case, so I decide to not print anything
    // here to void confusion when seeing this error in the log
    async (pr_info: PRandJobs, _e: Error) => {
      // Insert dummy values if merge base can't be found
      pr_info.merge_base =
        "failed to retrieve merge base, please contact dev infra";
      // NB: Leave the merge base date empty or undefined here, any mock value
      // like 0 is treated as a timestamp to use when quering similar failures
      pr_info.merge_base_date = "";
    }
  );
}

export async function getBaseCommitJobs(
  workflowsByPR: Map<number, PRandJobs>
): Promise<Map<string, Map<string, RecentWorkflowsData[]>>> {
  // get merge base shas
  const baseShas = _.uniq(
    Array.from(workflowsByPR.values()).map((v) => v.merge_base)
  );

  // fetch failing jobs on those shas
  const commitFailedJobsQueryResult = await fetchFailedJobsFromCommits(
    baseShas
  );

  // reorganize into a map of sha -> name -> data
  const jobsBySha = new Map();
  for (const job of commitFailedJobsQueryResult) {
    if (!jobsBySha.has(job.head_sha)) {
      jobsBySha.set(job.head_sha, new Map());
    }
    const existing_job = jobsBySha.get(job.head_sha).get(job.name);
    if (!existing_job || existing_job.id < job.id) {
      // if rerun, choose the job with the larger id as that is more recent
      jobsBySha.get(job.head_sha).set(job.name, job);
    }
  }

  const jobsByShaByName = new Map();
  // regroup the list of failed jobs one more time to remove the shard ID and
  // the unstable suffix. The former is not needed because the tests could be
  // run by another shard and failed the same way. The unstable suffix is also
  // not needed because it's there only to decorate the job name.
  for (const sha of jobsBySha.keys()) {
    if (!jobsByShaByName.has(sha)) {
      jobsByShaByName.set(sha, new Map());
    }

    for (const jobName of jobsBySha.get(sha).keys()) {
      const jobNameNoSuffix = removeJobNameSuffix(jobName);
      const job = jobsBySha.get(sha).get(jobName);

      if (!jobsByShaByName.get(sha).has(jobNameNoSuffix)) {
        jobsByShaByName.get(sha).set(jobNameNoSuffix, []);
      }

      jobsByShaByName.get(sha).get(jobNameNoSuffix).push(job);
    }
  }

  return jobsByShaByName;
}

// Returns the set of job names (with shard/unstable suffix stripped) that ran
// at each merge-base SHA, regardless of conclusion. DrCI uses this to tell
// "this job did not run on base at all" (no signal -> Unknown) apart from
// "this job ran on base and passed" (PR-introduced regression -> new failure).
export async function getBaseCommitJobNames(
  workflowsByPR: Map<number, PRandJobs>
): Promise<Map<string, Set<string>>> {
  const baseShas = _.uniq(
    Array.from(workflowsByPR.values()).map((v) => v.merge_base)
  );

  const rows = await fetchJobNamesFromCommits(baseShas);

  const namesBySha = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!namesBySha.has(row.head_sha)) {
      namesBySha.set(row.head_sha, new Set());
    }
    namesBySha.get(row.head_sha)!.add(removeJobNameSuffix(row.name));
  }
  return namesBySha;
}

async function getExistingDrCiComments(
  repoFullName: string,
  workflowsByPR: Map<number, PRandJobs>
) {
  const existingCommentsQuery = `
select
  id,
  body,
  issue_url
from
  default.issue_comment final
where
  body like '%<!-- drci-comment-start -->%'
  and user.login = {drciCommentAuthor: String}
  and issue_url in {prUrls: Array(String)}
-- Order so the oldest comment lands last; the Map below keeps the last entry
-- per PR, so we deterministically pick the original Dr. CI comment if there
-- ever are multiple bot-authored marker comments (matches getDrciComment,
-- which returns the first match from chronologically-ordered listComments).
order by id desc
    `;
  return new Map(
    (
      await queryClickhouse(existingCommentsQuery, {
        drciCommentAuthor: DRCI_COMMENT_AUTHOR,
        prUrls: Array.from(workflowsByPR.keys()).map(
          (prNumber) =>
            `https://api.github.com/repos/${repoFullName}/issues/${prNumber}`
        ),
      })
    )?.map((v) => [
      parseInt(v.issue_url.split("/").pop()),
      { id: parseInt(v.id), body: v.body },
    ])
  );
}

function constructResultsJobsSections(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  header: string,
  description: string,
  jobs: RecentWorkflowsData[],
  suggestion?: string,
  collapsed: boolean = false,
  relatedJobs: Map<number, RecentWorkflowsData> = new Map(),
  relatedIssues: Map<number, IssueData[]> = new Map(),
  relatedInfo: Map<number, string> = new Map(),
  // job.id -> pre-rendered "AI verdict:" line, appended under each bullet.
  advisorLines: Map<number, string> = new Map()
): string {
  if (jobs.length === 0) {
    return "";
  }
  let output = `\n<details ${
    collapsed ? "" : "open"
  }><summary><b>${header}</b> - ${description}:</summary>`;

  if (suggestion) {
    output += `<p>👉 <b>${suggestion}</b></p>`;
  }

  output += "<p>\n\n"; // Two newlines are needed for bullts below to be formattec correctly

  const hudPrUrl = `${hudBaseUrl}/pr/${owner}/${repo}/${prNumber}`;
  const jobsSorted = jobs.sort((a, b) => a.name.localeCompare(b.name));
  for (const job of jobsSorted) {
    const isPendingIcon = isPending(job) ? ":hourglass_flowing_sand: " : "";
    output += `* ${isPendingIcon}[${job.name}](${hudPrUrl}#${job.id}) ([gh](${job.html_url}))`;

    const relatedJob = relatedJobs.get(job.id);
    // Show the related trunk failure for broken trunk or the similar failure for flaky
    if (relatedJob !== undefined) {
      const hudCommitUrl = `${hudBaseUrl}/${owner}/${repo}/commit/${relatedJob.head_sha}`;
      const relatedJobUrl = `${hudCommitUrl}#${relatedJob.id}`;
      if (header === "BROKEN TRUNK") {
        output += ` ([trunk failure](${relatedJobUrl}))`;
      } else if (header === "FLAKY") {
        output += ` ([similar failure](${relatedJobUrl}))`;
      } else {
        output += ` ([related job](${relatedJobUrl}))`;
      }
    }

    const relatedIssue = relatedIssues.get(job.id);
    // Show all the related issues
    if (relatedIssue !== undefined) {
      const issueInfo = relatedIssue
        .map(
          (issue) =>
            `[#${issue.number}](${issue.html_url.replace(
              "https://github.com",
              HUD_URL
            )})`
        )
        .join(", ");
      if (issueInfo) {
        output += ` (${issueInfo})`;
      }
    }

    const info = relatedInfo.get(job.id);
    // Show all the related information
    if (info !== undefined) {
      output += ` (${info})`;
    }

    output += "\n";
    if (job.failure_captures && job.failure_captures.length > 0) {
      output += `    \`${job.failure_captures[0]}\`\n`;
    }

    // AI advisor verdict line (badge + optional reasoning expand), if any.
    const advisorLine = advisorLines.get(job.id);
    if (advisorLine) {
      output += advisorLine;
    }
  }
  output += "</p></details>";
  return output;
}

function pluralize(word: string, count: number, pluralForm?: string): string {
  if (count === 1) {
    return word;
  }

  if (pluralForm) {
    return pluralForm;
  }

  return `${word}s`;
}

// Whether the Dr.CI headline shows the success icon: nothing failed, was
// cancelled, is unclassified, awaits approval or is pending. Unrelated failures
// (flaky, broken trunk, ...) do not count.
export function isDrciGreen({
  pending,
  failedJobs,
  unknownJobs,
  awaitingApprovalJobs,
}: {
  pending: number;
  failedJobs: RecentWorkflowsData[];
  unknownJobs: RecentWorkflowsData[];
  awaitingApprovalJobs: RecentWorkflowsData[];
}): boolean {
  return (
    pending === 0 &&
    failedJobs.length === 0 &&
    unknownJobs.length === 0 &&
    awaitingApprovalJobs.length === 0
  );
}

// The ready for review promotion's CI rule: the headline's, except that
// workflows waiting for a maintainer to approve their run do not block.
export function isCiGoodForReview(
  args: Parameters<typeof isDrciGreen>[0]
): boolean {
  return isDrciGreen({
    ...args,
    awaitingApprovalJobs: args.awaitingApprovalJobs.filter(
      (job) => job.conclusion !== "action_required"
    ),
  });
}

export function constructResultsComment(
  pending: number,
  failedJobs: RecentWorkflowsData[],
  flakyJobs: RecentWorkflowsData[],
  brokenTrunkJobs: RecentWorkflowsData[],
  unstableJobs: RecentWorkflowsData[],
  unknownJobs: RecentWorkflowsData[],
  awaitingApprovalJobs: RecentWorkflowsData[],
  crcrL3Jobs: RecentWorkflowsData[],
  aiNotRelatedJobs: RecentWorkflowsData[],
  relatedJobs: Map<number, RecentWorkflowsData>,
  relatedIssues: Map<number, IssueData[]>,
  relatedInfo: Map<number, string>,
  sha: string,
  merge_base: string,
  merge_base_date: string,
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  // job.id -> pre-rendered "AI verdict:" line (empty unless advisor-enabled).
  advisorLines: Map<number, string> = new Map(),
  // Pre-rendered Green Light section or eligibility line for this PR, already
  // carrying its own leading newline (empty when the PR has neither).
  greenlightSection: string = "",
  // Pre-rendered sections for the failing ciflow runs of the PRs above that also
  // test this PR, and their number of failures (see renderFailuresAbove).
  failuresAbove: { sections: string; count: number } = {
    sections: "",
    count: 0,
  }
): string {
  let output = `\n`;
  // Filter out unstable pending jobs
  const unrelatedFailureCount = _(flakyJobs)
    .concat(brokenTrunkJobs)
    .concat(unstableJobs)
    .concat(crcrL3Jobs)
    .concat(aiNotRelatedJobs)
    .filter((job) => !isPending(job))
    .value().length;
  const newFailedJobs: RecentWorkflowsData[] = failedJobs.filter(
    (job) =>
      job.conclusion !== "cancelled" &&
      !job.failure_captures.includes(CANCELLED_STEP_ERROR)
  );
  const cancelledJobs: RecentWorkflowsData[] = failedJobs.filter(
    (job) =>
      job.conclusion === "cancelled" ||
      job.failure_captures.includes(CANCELLED_STEP_ERROR)
  );
  const failing = failedJobs.length + unrelatedFailureCount;
  const headerPrefix = `## `;
  const pendingIcon = `:hourglass_flowing_sand:`;
  const successIcon = `:white_check_mark:`;
  const failuresIcon = `:x:`;
  const warningIcon = `:warning:`;
  const noneFailing = `No Failures`;
  const significantFailures = `${newFailedJobs.length} New ${pluralize(
    "Failure",
    newFailedJobs.length
  )}`;
  const cancelledFailures = `${cancelledJobs.length} Cancelled ${pluralize(
    "Job",
    cancelledJobs.length
  )}`;
  const unrelatedFailures = `${unrelatedFailureCount} Unrelated ${pluralize(
    "Failure",
    unrelatedFailureCount
  )}`;
  const unknownFailures = `${unknownJobs.length} Unclassified ${pluralize(
    "Failure",
    unknownJobs.length
  )}`;
  const pendingJobs = `${pending} Pending`;
  const awaitingApprovalMsg = `${awaitingApprovalJobs.length} Awaiting Approval`;
  const failuresAboveMsg = `${failuresAbove.count} ${pluralize(
    "Failure",
    failuresAbove.count
  )} Above`;

  const hasAnyFailing = failing > 0;
  const hasSignificantFailures = newFailedJobs.length > 0;
  const hasCancelledFailures = cancelledJobs.length > 0;
  const hasPending = pending > 0;
  const hasUnrelatedFailures = unrelatedFailureCount > 0;
  const hasUnknownFailures = unknownJobs.length > 0;
  const hasAwaitingApproval = awaitingApprovalJobs.length > 0;
  const hasFailuresAbove = failuresAbove.count > 0;
  const nothingFailing =
    !hasAnyFailing &&
    !hasAwaitingApproval &&
    !hasUnknownFailures &&
    !hasFailuresAbove;

  let icon = "";
  if (
    !hasFailuresAbove &&
    isDrciGreen({ pending, failedJobs, unknownJobs, awaitingApprovalJobs })
  ) {
    icon = successIcon;
  } else if (
    hasFailuresAbove ||
    hasSignificantFailures ||
    hasCancelledFailures ||
    hasUnknownFailures
  ) {
    icon = failuresIcon;
  } else if (hasAwaitingApproval) {
    icon = warningIcon;
  } else {
    icon = pendingIcon;
  }

  let title_messages = [];
  if (hasAwaitingApproval) {
    title_messages.push(awaitingApprovalMsg);
  }
  if (hasSignificantFailures) {
    title_messages.push(significantFailures);
  }
  if (hasCancelledFailures) {
    title_messages.push(cancelledFailures);
  }
  if (hasFailuresAbove) {
    title_messages.push(failuresAboveMsg);
  }
  if (nothingFailing) {
    title_messages.push(noneFailing);
  }
  if (hasPending) {
    title_messages.push(pendingJobs);
  }
  if (hasUnrelatedFailures) {
    let unrelatedFailuresMsg = unrelatedFailures;
    if (title_messages.length == 0) {
      // If there are no other messages, reassure the user that things are looking good
      unrelatedFailuresMsg =
        "You can merge normally! (" + unrelatedFailures + ")";
    }

    title_messages.push(unrelatedFailuresMsg);
  }
  if (hasUnknownFailures) {
    title_messages.push(unknownFailures);
  }

  let title = headerPrefix + icon + " " + title_messages.join(", ");
  output += title;

  output += `\nAs of commit ${sha} with merge base ${merge_base}`;
  const timestamp = dayjs.utc(merge_base_date).unix();
  if (!isNaN(timestamp)) {
    output += ` (<sub><sub><img alt="image" width=70 src="https://img.shields.io/date/${timestamp}?label=&color=FFFFFF&style=flat-square"></sub></sub>)`;
  }
  output += ":";

  if (nothingFailing) {
    output += `\n:green_heart: Looks good so far! There are no failures yet. :green_heart:`;
  }

  // A verdict on the PR as a whole rather than a job bucket, so it reads before
  // the per-bucket failure lists.
  output += greenlightSection;
  output += failuresAbove.sections;

  if (awaitingApprovalJobs.length) {
    output += constructResultsJobsSections(
      hudBaseUrl,
      owner,
      repo,
      prNumber,
      `AWAITING APPROVAL`,
      `The following ${
        awaitingApprovalJobs.length > 1 ? "workflows need" : "workflow needs"
      } approval before CI can run`,
      awaitingApprovalJobs,
      "",
      false,
      relatedJobs,
      relatedIssues,
      relatedInfo
    );
  }

  // advisorLines is threaded only into the NEW FAILURES, UNCLASSIFIED and
  // advisor-cleared sections -- those are the only failures the advisor
  // dispatches on. Broken-trunk / flaky / unstable / awaiting-approval jobs are
  // already explained by their own section, so they intentionally get no
  // verdict line.
  if (newFailedJobs.length) {
    output += constructResultsJobsSections(
      hudBaseUrl,
      owner,
      repo,
      prNumber,
      `NEW ${pluralize("FAILURE", newFailedJobs.length).toLocaleUpperCase()}`,
      `The following ${
        newFailedJobs.length > 1 ? "jobs have" : "job has"
      } failed`,
      newFailedJobs,
      "",
      false,
      relatedJobs,
      relatedIssues,
      relatedInfo,
      advisorLines
    );
  }

  // Directly after NEW FAILURES: these are the jobs lifted out of it, so they
  // read as that section's footnote rather than as an unrelated bucket.
  output += constructResultsJobsSections(
    hudBaseUrl,
    owner,
    repo,
    prNumber,
    "NEW FAILURES SUPPRESSED BY AI (non-blocking)",
    // "not evidence against this change" is the only claim true of all three
    // cleared verdicts -- see SUPPRESSIBLE_VERDICTS. `infra_issue` says the
    // environment broke, which a PR can itself cause, and `garbage` judges the
    // signal rather than the change, so "unrelated to the change" would be
    // false for both. Keep the umbrella wording if this gets shortened again.
    `The following ${pluralize(
      "job",
      aiNotRelatedJobs.length
    )} failed, but the AI CI Advisor judged the ${pluralize(
      "failure",
      aiNotRelatedJobs.length
    )} not to be evidence against this change`,
    aiNotRelatedJobs,
    "",
    true,
    relatedJobs,
    relatedIssues,
    relatedInfo,
    advisorLines
  );

  if (unknownJobs.length) {
    output += constructResultsJobsSections(
      hudBaseUrl,
      owner,
      repo,
      prNumber,
      `UNCLASSIFIED ${pluralize(
        "FAILURE",
        unknownJobs.length
      ).toLocaleUpperCase()}`,
      `DrCI could not classify the following ${pluralize(
        "job",
        unknownJobs.length
      )} because the workflow did not run on the merge base. The ${pluralize(
        "failure",
        unknownJobs.length
      )} may be pre-existing on trunk or introduced by this PR`,
      unknownJobs,
      "",
      false,
      relatedJobs,
      relatedIssues,
      relatedInfo,
      advisorLines
    );
  }

  if (cancelledJobs.length) {
    output += constructResultsJobsSections(
      hudBaseUrl,
      owner,
      repo,
      prNumber,
      `CANCELLED ${pluralize("JOB", cancelledJobs.length).toLocaleUpperCase()}`,
      `The following ${
        cancelledJobs.length > 1 ? "jobs were" : "job was"
      } cancelled. Please retry`,
      cancelledJobs,
      "",
      true,
      relatedJobs,
      relatedIssues,
      relatedInfo
    );
  }

  output += constructResultsJobsSections(
    hudBaseUrl,
    owner,
    repo,
    prNumber,
    "FLAKY",
    `The following ${pluralize("job", flakyJobs.length)} failed but ${pluralize(
      "was",
      flakyJobs.length,
      "were"
    )} likely due to flakiness present on trunk`,
    flakyJobs,
    "",
    true,
    relatedJobs,
    relatedIssues,
    relatedInfo
  );
  output += constructResultsJobsSections(
    hudBaseUrl,
    owner,
    repo,
    prNumber,
    "BROKEN TRUNK",
    `The following ${pluralize(
      "job",
      brokenTrunkJobs.length
    )} failed but ${pluralize(
      "was",
      flakyJobs.length,
      "were"
    )} present on the merge base`,
    brokenTrunkJobs,
    "Rebase onto the `viable/strict` branch to avoid these failures",
    true,
    relatedJobs,
    relatedIssues,
    relatedInfo
  );
  output += constructResultsJobsSections(
    hudBaseUrl,
    owner,
    repo,
    prNumber,
    "UNSTABLE",
    `The following ${pluralize("job", unstableJobs.length)} ${pluralize(
      "is",
      unstableJobs.length,
      "are"
    )} marked as unstable, possibly due to flakiness on trunk`,
    unstableJobs,
    "",
    true,
    relatedJobs,
    relatedIssues,
    relatedInfo
  );
  output += constructResultsJobsSections(
    hudBaseUrl,
    owner,
    repo,
    prNumber,
    "CRCR (non-blocking)",
    `The following CRCR downstream CI ${pluralize(
      "job",
      crcrL3Jobs.length
    )} failed but ${pluralize("is", crcrL3Jobs.length, "are")} non-blocking`,
    crcrL3Jobs,
    "",
    true,
    relatedJobs,
    relatedIssues,
    relatedInfo
  );
  return output;
}

function isFlaky(
  job: RecentWorkflowsData,
  flakyRules: FlakyRule[]
): FlakyRule | undefined {
  return flakyRules.find((flakyRule) => {
    const jobNameRegex = new RegExp(flakyRule.name);

    return (
      job.name.match(jobNameRegex) &&
      flakyRule.captures.every((capture: string) => {
        const captureRegex = new RegExp(capture);
        const matchFailureCaptures: boolean = job.failure_captures.some(
          (failureCapture) => failureCapture.match(captureRegex)
        );
        const matchFailureLine: boolean =
          job.failure_lines.length > 0 &&
          job.failure_lines[0].match(captureRegex) != null;

        // Accept both failure captures array and failure line string to make sure
        // that nothing is missing
        return matchFailureCaptures || matchFailureLine;
      })
    );
  });
}

function getTrunkFailure(
  job: RecentWorkflowsData,
  baseJobs: Map<string, RecentWorkflowsData[]>
): RecentWorkflowsData | undefined {
  const jobNameNoSuffix = removeJobNameSuffix(job.name);

  // This job doesn't exist in the base commit, thus not a broken trunk failure
  if (!baseJobs.has(jobNameNoSuffix)) {
    return;
  }

  return baseJobs
    .get(jobNameNoSuffix)!
    .find((baseJob) => isSameFailure(baseJob, job));
}

function isPending(job: RecentWorkflowsData): boolean {
  return job.conclusion === "" && isTime0(job.completed_at);
}

/**
 * Split CRCR downstream job results (from fetchCrcrWorkflows) into the
 * PR-visible L3 bucket and the always-blocking L4 bucket.
 *
 * L3 is opt-in: the relay (allowlist.py's needs_check_run) only creates an
 * upstream check run for an L3 repo when the PR carries that repo's
 * ciflow/crcr/<device> label. But every L1+ repo participating in
 * pull_request events is dispatched -- and forwarded to HUD -- on every PR
 * regardless of labels (shadow observation for L1/L2, plus e.g. crcr-test's
 * own post-merge self-tests, which deliberately run on landed PRs that never
 * carried its label). Without re-applying the same label gate here, every one
 * of those unlabeled shadow runs would resurface on the PR comment even
 * though the PR never opted in and no check run was ever created for it.
 * L4 has no such gate: it always blocks, regardless of labels.
 */
export function classifyCrcrJobs(
  crcrWorkflows: RecentWorkflowsData[],
  labels: string[],
  crcrAllowlist: CrcrAllowlist | null
): { crcrL3Jobs: RecentWorkflowsData[]; crcrL4Jobs: RecentWorkflowsData[] } {
  const crcrL3Jobs: RecentWorkflowsData[] = [];
  const crcrL4Jobs: RecentWorkflowsData[] = [];
  for (const job of crcrWorkflows) {
    const level = job.downstreamLevel || "";
    if (level === "L3") {
      const device = crcrAllowlist?.getDeviceForRepo(job.downstreamRepo || "");
      if (device && labels.includes(`ciflow/crcr/${device}`)) {
        crcrL3Jobs.push(job);
      }
    } else if (level === "L4") {
      crcrL4Jobs.push(job);
    }
  }
  return { crcrL3Jobs, crcrL4Jobs };
}

export async function getWorkflowJobsStatuses(
  prInfo: PRandJobs,
  flakyRules: FlakyRule[],
  baseJobs: Map<string, RecentWorkflowsData[]>,
  labels: string[] = [],
  unstableIssues: IssueData[] = [],
  disabledTestIssues: IssueData[] = [],
  mergeCommits: string[] = [],
  baseJobNames?: Set<string>
): Promise<{
  pending: number;
  failedJobs: RecentWorkflowsData[];
  flakyJobs: RecentWorkflowsData[];
  brokenTrunkJobs: RecentWorkflowsData[];
  unstableJobs: RecentWorkflowsData[];
  unknownJobs: RecentWorkflowsData[];
  awaitingApprovalJobs: RecentWorkflowsData[];
  relatedJobs: Map<number, RecentWorkflowsData>;
  relatedIssues: Map<number, IssueData[]>;
  relatedInfo: Map<number, string>;
}> {
  let pending = 0;
  const preprocessFailedJobs: RecentWorkflowsData[] = [];
  const flakyJobs: RecentWorkflowsData[] = [];
  const brokenTrunkJobs: RecentWorkflowsData[] = [];
  const unstableJobs: RecentWorkflowsData[] = [];
  const failedJobs: RecentWorkflowsData[] = [];
  const unknownJobs: RecentWorkflowsData[] = [];
  const awaitingApprovalJobs: RecentWorkflowsData[] = [];

  // This map holds the list of the base failures for broken trunk jobs or the similar
  // failures for flaky jobs
  const relatedJobs: Map<number, RecentWorkflowsData> = new Map();
  // Maps job id -> associated unstable issue that disables a job
  const relatedIssues: Map<number, IssueData[]> = new Map();
  // Any additional information about the job classification can be kept here
  const relatedInfo: Map<number, string> = new Map();

  for (const job of prInfo.jobs) {
    // Check for workflows awaiting approval (first-time contributors need maintainer approval)
    if (
      job.conclusion === "action_required" ||
      job.conclusion === "startup_failure"
    ) {
      awaitingApprovalJobs.push(job);
      continue;
    }

    if (isPending(job)) {
      pending++;
      if (isUnstableJob(job as any, unstableIssues)) {
        unstableJobs.push(job);
        relatedIssues.set(
          job.id,
          getOpenUnstableIssues(job.name, unstableIssues)
        );
      }
    } else if (isFailedOrCancelled(job)) {
      const suppressedLabels = await getSuppressedLabels(job, labels);
      if (prInfo.repo === "pytorch" && suppressedLabels.length !== 0) {
        flakyJobs.push(job);
        relatedInfo.set(job.id, `suppressed by ${suppressedLabels.join(", ")}`);
        continue;
      }

      // TODO: remove the `as any` cast when CH migration is complete
      if (isUnstableJob(job as any, unstableIssues)) {
        unstableJobs.push(job);
        relatedIssues.set(
          job.id,
          getOpenUnstableIssues(job.name, unstableIssues)
        );
        continue;
      }

      if (isExcludedFromBrokenTrunk(job)) {
        failedJobs.push(job);
        continue;
      }

      const trunkFailure = getTrunkFailure(job, baseJobs);
      if (trunkFailure !== undefined) {
        brokenTrunkJobs.push(job);
        relatedJobs.set(job.id, trunkFailure);
        continue;
      }

      if (isExcludedFromFlakiness(job)) {
        // No flakiness signal will be checked for this job. If it also did not
        // run on the merge base, DrCI has nothing to compare against -> Unknown.
        if (
          baseJobNames !== undefined &&
          !baseJobNames.has(removeJobNameSuffix(job.name))
        ) {
          unknownJobs.push(job);
          relatedInfo.set(
            job.id,
            "this job did not run on the merge base, so DrCI cannot tell whether the failure is pre-existing"
          );
          continue;
        }
        failedJobs.push(job);
        continue;
      }

      const flakyRule = isFlaky(job, flakyRules);
      if (flakyRule !== undefined) {
        flakyJobs.push(job);
        relatedInfo.set(
          job.id,
          `matched **${flakyRule.name}** rule in [flaky-rules.json](https://github.com/pytorch/test-infra/blob/generated-stats/stats/flaky-rules.json)`
        );
        continue;
      }

      if (isInfraFlakyJob(job)) {
        flakyJobs.push(job);
        relatedInfo.set(job.id, `detected as infra flaky with no runner`);
        continue;
      }

      if (await isLogClassifierFailed(job)) {
        flakyJobs.push(job);
        relatedInfo.set(
          job.id,
          `detected as infra flaky with no log or failing log classifier`
        );
        await backfillMissingLog(prInfo.owner, prInfo.repo, job);
        continue;
      }

      const matchDisabledTestIssues = getDisabledTestIssues(
        job,
        disabledTestIssues
      );
      if (
        matchDisabledTestIssues.length !== 0 &&
        isRecentlyCloseDisabledTest(
          matchDisabledTestIssues,
          prInfo.merge_base_date
        )
      ) {
        const disabledTestIssuesMsg = matchDisabledTestIssues
          .map(
            (issue) =>
              `[#${issue.number}](${issue.html_url.replace(
                "https://github.com",
                HUD_URL
              )})`
          )
          .join(", ");
        relatedInfo.set(
          job.id,
          `disabled by ${disabledTestIssuesMsg} but the issue was closed recently and a rebase is needed to make it pass`
        );

        if (!isDisabledTestMentionedInPR(matchDisabledTestIssues, prInfo)) {
          flakyJobs.push(job);
          continue;
        }
      }

      if (
        matchDisabledTestIssues.length !== 0 &&
        isDisabledTest(matchDisabledTestIssues)
      ) {
        if (isDisabledTestMentionedInPR(matchDisabledTestIssues, prInfo)) {
          // If the test is disabled and it's mentioned in the PR, its failure
          // would be legit, for example, the PR is trying to fix the flaky test
          relatedIssues.set(job.id, matchDisabledTestIssues);
        } else {
          // If the test is disabled and it's NOT mentioned anywhere in the PR,
          // its failure is consider flaky
          flakyJobs.push(job);
          const disabledTestIssuesMsg = matchDisabledTestIssues
            .map(
              (issue) =>
                `[#${issue.number}](${issue.html_url.replace(
                  "https://github.com",
                  HUD_URL
                )})`
            )
            .join(", ");
          relatedInfo.set(job.id, `disabled by ${disabledTestIssuesMsg}`);
          continue;
        }
      }

      if (prInfo.repo === "pytorch") {
        // NB: Searching for similar failures depends on the accuracy of the log
        // classifier, so we only enable this in PyTorch core atm where the log
        // classifier works decently well
        const similarFailure = await hasSimilarFailures(
          job,
          prInfo.merge_base_date,
          mergeCommits
        );
        if (similarFailure !== undefined) {
          flakyJobs.push(job);
          relatedJobs.set(job.id, similarFailure);
          continue;
        }
      }

      preprocessFailedJobs.push(job);
    }
  }

  // Verify that the failed job is unique and there is no similar flaky, broken trunk,
  // or unstable jobs in the same pull request. If there are some, these failures are
  // also considered unrelated
  for (const job of preprocessFailedJobs) {
    // If the failure is a generic error, don't do anything because we run the
    // risk of getting false positives
    if (isExcludedFromSimilarityPostProcessing(job)) {
      failedJobs.push(job);
      continue;
    }

    // Some jobs are marked as unstable while similar ones are not, i.e. different CUDA/python versions
    const similarUnstableFailure = hasSimilarFailuresInSamePR(
      job,
      unstableJobs
    );
    if (similarUnstableFailure !== undefined) {
      unstableJobs.push(job);
      relatedJobs.set(job.id, similarUnstableFailure);
      continue;
    }

    // Searching for similar flaky failures miss this case
    const similarFlakyFailure = hasSimilarFailuresInSamePR(job, flakyJobs);
    if (similarFlakyFailure !== undefined) {
      flakyJobs.push(job);
      relatedJobs.set(job.id, similarFlakyFailure);
      continue;
    }

    // Broken trunk between trunk and periodic jobs
    const similarBrokenTrunkFailure = hasSimilarFailuresInSamePR(
      job,
      brokenTrunkJobs
    );
    if (similarBrokenTrunkFailure !== undefined) {
      flakyJobs.push(job);
      relatedJobs.set(job.id, similarBrokenTrunkFailure);
      continue;
    }

    // If this job did not run on the merge base at all, DrCI has no signal to
    // tell whether the failure is pre-existing or PR-introduced. Surface it as
    // Unknown rather than blaming the PR. Only applies when the caller passes
    // baseJobNames; tests that omit it preserve legacy behavior.
    if (
      baseJobNames !== undefined &&
      !baseJobNames.has(removeJobNameSuffix(job.name))
    ) {
      unknownJobs.push(job);
      relatedInfo.set(
        job.id,
        "this job did not run on the merge base, so DrCI cannot tell whether the failure is pre-existing"
      );
      continue;
    }

    failedJobs.push(job);
  }

  return {
    pending,
    failedJobs,
    flakyJobs,
    brokenTrunkJobs,
    unstableJobs,
    unknownJobs,
    awaitingApprovalJobs,
    relatedJobs,
    relatedIssues,
    relatedInfo,
  };
}

export async function reorganizeWorkflows(
  owner: string,
  repo: string,
  recentWorkflows: RecentWorkflowsData[],
  octokit?: Octokit
): Promise<Map<number, PRandJobs>> {
  // Dedup because the input can contain the same job multiple times due to the
  // two queries for recent workflows and for comments with pending jobs
  const dedupedRecentWorkflows = _.uniqBy(recentWorkflows, (workflow) =>
    JSON.stringify([
      workflow.id,
      workflow.workflowId,
      workflow.head_sha,
      workflow.pr_number,
      workflow.name,
    ])
  );
  const workflowsByPR: PRandJobs[] = await Promise.all(
    _(dedupedRecentWorkflows)
      .groupBy("pr_number")
      .map(async (workflows, prNumber) => {
        // NB: The head SHA timestamp is currently used as the end date when
        // searching for similar failures.  However, it's not available on CH for
        // commits from forked PRs before a ciflow ref is pushed.  In such case,
        // the head SHA timestamp will be undefined and we will make an additional
        // query to GitHub to get the value
        let headShaTimestamp = workflows.find(
          (workflow) => !isTime0(workflow.head_sha_timestamp)
        )?.head_sha_timestamp;
        if (octokit && headShaTimestamp === undefined) {
          headShaTimestamp = await fetchCommitTimestamp(
            octokit,
            owner,
            repo,
            workflows[0].head_sha
          );
        }
        workflows.forEach((workflow) => {
          if (isTime0(workflow.head_sha_timestamp) && headShaTimestamp) {
            workflow.head_sha_timestamp = headShaTimestamp;
          }
        });

        let prTitle = "";
        let prBody = "";
        let prShas: { sha: string; title: string }[] = [];
        let prHeadRef = "";
        // Gate this to PyTorch as disabled tests feature is only available there
        if (octokit && repo === "pytorch") {
          const prData = await fetchPR(
            owner,
            repo,
            `${prNumber}`,
            octokit,
            workflows[0].head_sha
          );
          prTitle = prData.title;
          prBody = prData.body;
          prShas = prData.shas;
          prHeadRef = prData.headRef ?? "";
        }

        return {
          pr_number: parseInt(prNumber),
          head_sha: workflows[0].head_sha,
          head_sha_timestamp: headShaTimestamp ?? "",
          jobs: workflows,
          merge_base: "",
          merge_base_date: "",
          owner: owner,
          repo: repo,
          title: prTitle,
          body: prBody,
          shas: prShas,
          headRef: prHeadRef,
        };
      })
      .value()
  );

  // clean up the workflows - remove retries, remove workflows that have jobs,
  // remove cancelled jobs with weird names
  for (const prInfo of workflowsByPR) {
    const [workflows, jobs] = _.partition(
      prInfo.jobs,
      (job) => job.workflowId === 0
    );

    // Get most recent workflow run based on workflowUniqueId (workflow_id in webhooks)
    const recentWorkflows: Map<number, RecentWorkflowsData> = new Map();
    for (const workflow of workflows) {
      // Check that this is a workflow, not a job
      const workflowUniqueId = workflow.workflowUniqueId;
      const existingWorkflowId = recentWorkflows.get(workflowUniqueId)?.id;
      if (!existingWorkflowId || existingWorkflowId < workflow.id) {
        recentWorkflows.set(workflowUniqueId, workflow);
      }
    }

    // Remove retries
    const removeRetries = new Map();
    for (const job of jobs) {
      if (
        job.workflowUniqueId &&
        recentWorkflows.get(job.workflowUniqueId) &&
        job.workflowId !== recentWorkflows.get(job.workflowUniqueId)!.id
      ) {
        // This belongs to an older run of the workflow
        continue;
      }
      const key = job.name;
      const existing_job = removeRetries.get(key);
      if (!existing_job || existing_job.id < job.id!) {
        removeRetries.set(key, job);
      }
    }

    const workflowIdsWithJobs = new Set(
      Array.from(removeRetries.values()).map((job) => job.workflowId)
    );

    // Keep only workflows with no jobs
    const goodWorkflows = Array.from(recentWorkflows.values()).filter(
      (workflow: RecentWorkflowsData) => !workflowIdsWithJobs.has(workflow.id)
    );

    const allJobs = Array.from(removeRetries.values()).concat(goodWorkflows);
    // Remove cancelled jobs with weird names
    prInfo.jobs = removeCancelledJobAfterRetry<RecentWorkflowsData>(allJobs);
  }
  return workflowsByPR.reduce((acc, prInfo) => {
    acc.set(prInfo.pr_number, prInfo);
    return acc;
  }, new Map<number, PRandJobs>());
}

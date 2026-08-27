# PyTorch Bot Architecture Analysis

- [PyTorch Bot Architecture Analysis](#pytorch-bot-architecture-analysis)
  - [Overview](#overview)
  - [Bot Modules](#bot-modules)
    - [pytorchBot](#pytorchbot)
    - [ciflowPushTrigger.ts](#ciflowpushtriggerts)
      - [Configuration (ciflow_push_tags)](#configuration-ciflow_push_tags)
    - [webhookToDynamo.ts](#webhooktodynamots)
    - [autoLabelBot.ts](#autolabelbotts)
    - [autoCcBot.ts](#autoccbotts)
    - [retryBot.ts](#retrybotts)
    - [cancelWorkflowsOnCloseBot.ts](#cancelworkflowsonclosebotts)
    - [verifyDisableTestIssueBot.ts](#verifydisabletestissuebotts)
    - [stripApprovalBot.ts](#stripapprovalbotts)
    - [codevNoWritePermBot.ts](#codevnowritepermbotts)
    - [drciBot.ts](#drcibotts)
    - [greenlightBot.ts](#greenlightbotts)
  - [External Integrations](#external-integrations)
    - [Data Storage](#data-storage)
    - [CI Systems](#ci-systems)
    - [Configuration Management](#configuration-management)
  - [Key Features](#key-features)
    - [Intelligent Merge System](#intelligent-merge-system)
    - [Smart Retry Logic (`retryBot.ts`)](#smart-retry-logic-retrybotts)
    - [Permission-based Security](#permission-based-security)
    - [Auto-labeling Intelligence](#auto-labeling-intelligence)
  - [Integration Architecture](#integration-architecture)
  - [Deployment Context](#deployment-context)
  - [Configuration File](#configuration-file)

## Overview

The PyTorch bot is a GitHub webhook automation system built with **Probot** that manages CI/CD workflows, code reviews, and development operations for the PyTorch ecosystem. It's deployed as a Next.js application on Vercel and integrates with multiple external services.

- **Main Entry**: `lib/bot/index.ts:19` - Registers the PyTorch Bot app's modules with Probot, served at `/api/github/webhooks`. `greenlightBot.ts` is deliberately _not_ registered here: it runs as a second Probot instance under a second GitHub App on its own route (see [greenlightBot.ts](#greenlightbotts))

## Bot Modules

### pytorchBot

**Primary Purpose:** Entry point for Probot that listens to issue comments and pull request review events, parses `@pytorchbot` and `@pytorchmergebot` commands and forwards them to the `PytorchBotHandler` which implements the command behavior and permission checks.

**Triggers / Webhooks:**

- `issue_comment.created` — Parses comments for `@pytorchbot` command lines and handles PR/issue commands.
- `pull_request_review.submitted` and `pull_request_review.edited` — Parses review body for commands.

**Supported Commands (via `cliParser`):**

- `merge` — Merge a PR (supports `-f/--force`, `-i/--ignore-current`, `-r/--rebase`).
- `revert` — Revert a merged PR (requires message & classification).
- `rebase` — Rebase a PR to a target branch (defaults to `viable/strict`).
- `label` — Add labels to a PR or Issue.
- `drci` — Update Dr. CI comment for the PR.
- `cherry-pick` — Cherry-pick a PR onto a release branch (`--onto/--into`, `--classification`).
- `help` — Get help text for the bot or command. Examples: `@pytorchbot --help`, `@pytorchbot merge -h`. This [wiki page](https://github.com/pytorch/pytorch/wiki/Bot-commands) also has the help text but may be out of date.

**Important behaviors & integrations:**

- Commands are parsed by `cliParser.ts` (argument definitions and help text live there).
- Permission checks and core logic are implemented in `pytorchBotHandler.ts` (e.g., `hasWritePermissions`, `hasRebasePermissions`, approval checks).
- On valid commands the handler emits repository dispatch events such as `try-merge`, `try-rebase`, and `try-revert` which perform the actual work asynchronously.
- The bot reacts to commands with a +1 reaction when appropriate and can post comments for failures or help text.
- The handler integrates with other systems: ClickHouse (workflows/analytics), DynamoDB logging via `pytorchbotLogger`, and CachedConfigTracker for repo configs.
- Issue comments are ignored when authored by known bot user IDs (see `pytorchBot.ts` skipUsers list).

**Related files:**

- `pytorchBot.ts` — Probot registration and webhook listeners.
- `pytorchBotHandler.ts` — Command handling, permission enforcement and dispatch logic.
- `cliParser.ts` — Command-line parser and help text generator for supported commands.
- `utils.ts` — Permission helpers, reaction helpers, config loader utilities.
- `pytorchbotLogger.ts` — Structured logging for bot actions.

### ciflowPushTrigger.ts

**Primary Purpose:** Manages Git tags that trigger CI workflows based on CI flow labels applied to PRs.

**Key Features:**

- **Tag synchronization**: Creates/updates Git tags when CI flow labels are added
- **Permission validation**: Ensures only authorized users can trigger CI flows
- **Tag cleanup**: Removes tags when labels are removed or PRs are closed
- **Configuration validation**: Validates labels against configured allowed CI flow tags
- **Permission-based filtering**: Removes CI flow labels from unauthorized PRs

**GitHub Webhooks:**

- `pull_request.labeled`, `pull_request.unlabeled`
- `pull_request.synchronize`, `pull_request.opened`, `pull_request.reopened`, `pull_request.closed`

**Special Logic:** Creates tags in format `ciflow/label/PR_NUMBER` to trigger downstream CI systems

#### Configuration (ciflow_push_tags)

Purpose: define which ciflow labels are allowed to create/update Git tags that trigger downstream CI systems. The `ciflowPushTrigger` bot reads this key from the repository configuration to validate labels and decide whether to push tags.

The config option should be put in the repository's `.github/pytorch-probot.yml` file. If not present in the repository, the bot will look for `.github/pytorch-probot.yml` in the owner's github repository (org/owner-level defaults).

Format:

```yaml
ciflow_push_tags:
  - ciflow/trunk
  - ciflow/foo
```

### webhookToDynamo.ts

**Primary Purpose:** Logs GitHub webhook events to DynamoDB tables for analytics and auditing.

**Key Features:**

- **Comprehensive logging**: Captures workflow runs, jobs, issues, PRs, comments, and reviews
- **Structured storage**: Organizes data into specific DynamoDB tables by event type
- **Key prefixing**: Prevents conflicts by prefixing keys with repository information
- **Label tracking**: Special handling for label events with timestamp tracking
- **UUID generation**: Uses UUIDs for events that don't have natural unique identifiers

**GitHub Webhooks:**

- `workflow_job`, `workflow_run`, `issues`, `issue_comment`
- `pull_request`, `pull_request_review`, `pull_request_review_comment`, `push`

**Special Logic:** Forms the foundation of the analytics and monitoring infrastructure by persisting all relevant GitHub events

### autoLabelBot.ts

**Primary Purpose:** Automatically assigns labels to pull requests and issues based on various criteria including file paths, titles, and patterns.

**Key Features:**

- **Title-based labeling**: Matches PR/issue titles against regex patterns to assign relevant labels
- **File-based labeling**: Analyzes changed files to assign module-specific and release note labels
- **Repository-specific rules**: Applies custom labeling rules based on the repository
- **CIFlow integration**: Assigns ciflow/\* labels based on changed files (e.g., MPS, H100 symmetry memory tests)
- **Release notes categorization**: Automatically categorizes PRs for release notes (PyTorch-specific)
- **Permission filtering**: Only applies CI flow labels if the author has appropriate permissions

**GitHub Webhooks:**

- `issues.labeled`, `issues.opened`, `issues.edited`
- `pull_request.opened`, `pull_request.edited`, `pull_request.synchronize`

**Special Logic:** Filters CI flow labels based on user permissions and workflow approval status

### autoCcBot.ts

**Primary Purpose:** Automatically CC (carbon copy) relevant users when specific labels are applied to issues or PRs.

**Key Features:**

- **Subscription management**: Loads user subscriptions from a tracking issue
- **Dynamic CC lists**: Updates CC lists in issue/PR descriptions based on applied labels
- **Self-removal**: Prevents users from being CC'd on their own issues/PRs
- **Incremental updates**: Only adds new CCs, preserving existing ones

**GitHub Webhooks:**

- `issues.labeled`
- `pull_request.labeled`

**Special Logic:** Parses subscription data from a configured tracking issue and maintains CC lists without duplicating existing mentions

### retryBot.ts

**Primary Purpose:** Intelligently retries failed CI workflows and jobs based on failure patterns and flakiness analysis.

**Key Features:**

- **Smart retry logic**: Distinguishes between infrastructure failures and code-related failures
- **Flaky job detection**: Queries ClickHouse for flaky job data from previous workflows
- **Configurable workflows**: Only retries workflows specified in configuration
- **Failure threshold**: Limits retries when too many jobs fail (>5 jobs)
- **Branch-specific behavior**: Different retry logic for main branch vs. feature branches
- **Always-retry jobs**: Specific jobs that are retried regardless of failure type

**GitHub Webhooks:**

- `workflow_run.completed`

**Special Logic:** Uses ML/analytics data from ClickHouse to make intelligent retry decisions

### cancelWorkflowsOnCloseBot.ts

**Primary Purpose:** Cancels running GitHub Actions workflows when PRs are closed to save compute resources.

**Key Features:**

- **Automatic cancellation**: Cancels all running workflows associated with a PR's head SHA
- **Bot exclusions**: Doesn't cancel workflows for bot users (pytorchbot, pytorchmergebot)
- **Repository filtering**: Only operates on pytorch/pytorch repository
- **Merge detection**: Skips cancellation for PRs that were actually merged
- **Batch processing**: Cancels multiple workflows concurrently

**GitHub Webhooks:**

- `pull_request.closed`

**Special Logic:** Prevents unnecessary resource usage by canceling workflows for closed/abandoned PRs

### verifyDisableTestIssueBot.ts

**Primary Purpose:** Validates and processes issues that request disabling or marking tests as unstable.

**Key Features:**

- **Title parsing**: Recognizes DISABLED and UNSTABLE prefixes in issue titles
- **Authorization validation**: Checks if users have permission to disable tests
- **Validation comments**: Posts detailed validation information about the disable request
- **Auto-closure**: Automatically closes unauthorized disable requests
- **Multi-format support**: Handles single test disables and aggregate disable issues

**GitHub Webhooks:**

- `issues.opened`, `issues.edited`

**Special Logic:** Critical security component that ensures only authorized users can disable CI tests

### stripApprovalBot.ts

**Primary Purpose:** Removes PR approvals when PRs are reopened to ensure fresh review.

**Key Features:**

- **Approval dismissal**: Automatically dismisses all existing approvals on PR reopening
- **Permission-based**: Only acts on PRs from users without write permissions
- **Notification messages**: Provides clear explanation for why approvals were removed
- **Security-focused**: Ensures that reopened PRs (potentially after reverts) get fresh review

**GitHub Webhooks:**

- `pull_request.reopened`

**Special Logic:** Maintains code review integrity by requiring fresh approvals after PR reopening

### codevNoWritePermBot.ts

**Primary Purpose:** Notifies Phabricator/Codev users when they need GitHub write permissions for CI.

**Key Features:**

- **Differential detection**: Recognizes PRs exported from Phabricator (Differential Revision markers)
- **Permission checking**: Verifies if the author has write permissions
- **Helpful messaging**: Provides links to internal documentation for getting permissions
- **Repository filtering**: Only operates on pytorch/pytorch repository

**GitHub Webhooks:**

- `pull_request.opened`

**Special Logic:** Bridges the gap between internal Facebook/Meta development workflow and external GitHub CI requirements

### drciBot.ts

**Primary Purpose:** Manages Dr. CI (Diagnostic CI) comments that provide comprehensive PR status information.

**Key Features:**

- **Status aggregation**: Creates/updates comprehensive status comments on PRs
- **Integration with DrCI utilities**: Leverages external DrCI infrastructure
- **PR state tracking**: Only operates on open PRs
- **URL integration**: Links to external Dr. CI dashboard

**GitHub Webhooks:**

- `pull_request.opened`, `pull_request.synchronize`

**Special Logic:** Serves as the interface between GitHub PRs and the comprehensive Dr. CI dashboard system

### greenlightBot.ts

**Primary Purpose:** Handles `@greenlight` commands on pull requests, so a trusted author can ask the Green Light AI reviewer to look at a PR again without leaving GitHub.

**Separate Probot instance:** Unlike every other module on this page, this bot is not registered in `index.ts` and is not served by `/api/github/webhooks`. It runs as its own Probot instance under its own GitHub App (the Green Light App), mounted on its own route at `pages/api/greenlight/webhooks.ts`. The two apps have separate app IDs, private keys, webhook secrets and installations, so installing the PyTorch Bot app on a repo does nothing for this bot — the Green Light App has to be installed there separately.

**Supported Commands (via `greenlightCliParser`):**

- `recheck` — Ask Green Light to review the pull request again.
- `help` — List the available commands. Has no other effect.

**GitHub Webhooks:**

- `issue_comment.created` — Pull requests only, and never on `edited`, so touching an old comment cannot re-run the command it holds. Comments authored by bots are ignored. Only a line that _starts_ with the mention is parsed, so quoting an earlier comment does not re-run its command. Both the mention and the command name are matched case-insensitively, which keeps the bot in step with greenlight's `is_bot_command` (`greenlight/src/greenlight/pr_hash.py`): that lowercases the body before looking for the trigger, so a differently-cased mention is dropped from the PR's fingerprint whether or not the bot acts on it. A mention that renders as sample text rather than as a live instruction is skipped — indented far enough to be a markdown code block, or inside a fence, an HTML comment or a `<pre>` block. Closing delimiters are optional, because CommonMark does not require them: an unclosed opener runs to the end of the comment, which matters most for an unterminated `<!--`, where nothing renders at all. A multiline `<code>` element is the one such region not skipped; inline `<code>` is already covered by the line-start anchor.

**Key Features:**

- **Least-privilege writes**: every write mints a fresh installation token scoped to a single repo and a single permission, instead of reusing the broad token Probot hands the handler.
- **Two-layer authorization**: a coarse write-permission check gates every command, and a commenter without write access — or one using an unrecognized command — gets a reaction rather than a comment, since a comment notifies every subscriber on the PR. A `recheck` additionally requires the requester to be on Green Light's trusted-author list (`greenlightTrustedAuthors.ts`, mirroring `TRUSTED_AUTHORS` in `greenlight/src/greenlight/review.py`), checked before the bot changes anything.
- **Org and repo gating**: only the orgs `isPyTorchbotSupportedOrg` allows, and within those only the repos named in the `GREENLIGHT_BOT_REPOS` allowlist. Enabling a repo is a configuration change rather than a code change, but Vercel applies environment variable changes only to new deployments, so it still takes a redeploy. An unset `GREENLIGHT_BOT_REPOS` enables the bot on nothing, and the route refuses to start without it.
- **Duplicate suppression**: a repeated `recheck` of the same PR inside a short in-memory window is dropped rather than starting a second reviewer run.
- **Workflow dispatch**: an accepted `recheck` removes the `Stale` label if present, dispatches `greenlight-review.yml` in `pytorch/test-infra` with the PR number and the commenter's login, then posts its acknowledgment comment and reacts to the triggering comment. The acknowledgment is written after the work it describes, so a delivery cut short partway leaves no comment claiming something that never happened.

**Special Logic:** `greenlight-review.yml` dispatches a reviewer that hard-codes `pytorch/pytorch`, so a `recheck` anywhere else is declined rather than dispatched against an unrelated PR of the same number. Removing the `Stale` label emits `pull_request.unlabeled` to the PyTorch Bot app, where `checkLabelsBot.ts` posts its `release notes:` label reminder if the PR lacks one — a common, expected side effect of a recheck on a long-idle PR.

**Related files:**

- `greenlightBot.ts` — Probot registration; bot-author, org and repo filtering.
- `greenlightBotHandler.ts` — Command handling, refusals, label removal, dispatch.
- `greenlightCliParser.ts` — Command vocabulary and the help text generated from it.
- `greenlightTrustedAuthors.ts` — The logins the bot and the Green Light backend will act for.
- `greenlightBotConfig.ts` — Required environment variables and the repo allowlist accessor.
- `greenlightAppAuth.ts` — Private-key handling and scoped installation-token minting.
- `greenlightWriter.ts` — The comment/react/label write surface and the workflow dispatcher.
- `repoAllowlist.ts` — `GREENLIGHT_BOT_REPOS` parsing and matching.
- `pages/api/greenlight/webhooks.ts` — The route and the Probot instance for the Green Light App.

## External Integrations

### Data Storage

- **DynamoDB**: Event logging, bot action tracking (`lib/bot/pytorchbotLogger.ts:4`)
- **ClickHouse**: CI analytics, flaky test data queries (`lib/bot/pytorchBotHandler.ts:5`)

### CI Systems

- **GitHub Actions**: Workflow triggering via repository dispatch events
- **Dr. CI**: Comprehensive status dashboard integration

### Configuration Management

- **Repository Configs**: `.github/pytorch-probot.yml` files (`lib/bot/utils.ts:64`)
- **Cached Config Tracker**: Performance optimization for config loading (`lib/bot/utils.ts:46`)
- **Label Subscriptions**: Issue-based user subscription management

## Key Features

### Intelligent Merge System

- **Approval Validation**: Reviews from COLLABORATOR+ required for PyTorch repos
- **Force Merge**: Admin-only with audit trail and reason requirement
- **CI Flow Labels**: Automatic trunk/pull label management
- **Branch Targeting**: Supports viable/strict and main branch merging

### Smart Retry Logic (`retryBot.ts`)

- **Flakiness Analysis**: Queries historical data to identify infrastructure failures
- **Selective Retrying**: Only retries jobs likely to succeed on retry
- **Branch-specific Rules**: Different behavior for main vs. feature branches

### Permission-based Security

- **Multi-tier Authorization**: Different permission levels for different actions
- **First-time Contributor Handling**: Restricted permissions for new contributors
- **Audit Logging**: All bot actions logged to DynamoDB

### Auto-labeling Intelligence

- **File Pattern Matching**: Assigns module labels based on changed files
- **CI Flow Detection**: Automatic ciflow/\* label assignment
- **Release Note Categorization**: Automated release note classification

## Integration Architecture

These bots work together as a cohesive CI/CD and development workflow system:

- **Permission System**: Multiple bots check `hasWritePermissions` and `hasApprovedPullRuns` for security
- **Configuration Management**: Many bots use `CachedConfigTracker` for repository-specific settings
- **Event Coordination**: Bots respond to related events (e.g., label changes trigger multiple bots)
- **Data Analytics**: Several bots feed data to ClickHouse and DynamoDB for decision-making
- **External Integrations**: Connect GitHub to CircleCI, Dr. CI dashboard, and internal Meta systems

## Deployment Context

- **Platform**: Vercel (Next.js)
- **Framework**: Probot (GitHub Apps framework)
- **Language**: TypeScript with modern ES modules
- **Monitoring**: DynamoDB logging + external Dr. CI dashboard

## Configuration File

- `.github/pytorch-probot.yml` - Some bots have settings or options that can be specified in this file. Please refer to the documentation for the individual bots to know what options are used.

# PyTorch Bot Architecture Analysis

- [PyTorch Bot Architecture Analysis](#pytorch-bot-architecture-analysis)
  - [Overview](#overview)
  - [Core Architecture](#core-architecture)
    - [Entry Points](#entry-points)
    - [Command System](#command-system)
    - [Permission System (`lib/bot/utils.ts:248`)](#permission-system-libbotutilsts248)
  - [Bot Modules](#bot-modules)
    - [Core Command Bots](#core-command-bots)
    - [Automation Bots](#automation-bots)
    - [CI Integration Bots](#ci-integration-bots)
    - [Security \& Review Bots](#security--review-bots)
    - [Infrastructure Bots](#infrastructure-bots)
  - [Detailed Bot Analysis](#detailed-bot-analysis)
    - [autoLabelBot.ts](#autolabelbotts)
    - [autoCcBot.ts](#autoccbotts)
    - [retryBot.ts](#retrybotts)
    - [ciflowPushTrigger.ts](#ciflowpushtriggerts)
      - [Configuration (ciflow_push_tags)](#configuration-ciflow_push_tags)
    - [cancelWorkflowsOnCloseBot.ts](#cancelworkflowsonclosebotts)
    - [verifyDisableTestIssueBot.ts](#verifydisabletestissuebotts)
    - [stripApprovalBot.ts](#stripapprovalbotts)
    - [codevNoWritePermBot.ts](#codevnowritepermbotts)
    - [drciBot.ts](#drcibotts)
    - [webhookToDynamo.ts](#webhooktodynamots)
  - [External Integrations](#external-integrations)
    - [Data Storage](#data-storage)
    - [CI Systems](#ci-systems)
    - [Configuration Management](#configuration-management)
  - [Key Features](#key-features)
    - [Intelligent Merge System](#intelligent-merge-system)
    - [Smart Retry Logic (`retryBot.ts`)](#smart-retry-logic-retrybotts)
    - [Permission-based Security](#permission-based-security)
    - [Auto-labeling Intelligence](#auto-labeling-intelligence)
  - [Data Flow](#data-flow)
  - [Integration Architecture](#integration-architecture)
  - [Deployment Context](#deployment-context)
  - [Configuration Files](#configuration-files)

## Overview

The PyTorch bot is a GitHub webhook automation system built with **Probot** that manages CI/CD workflows, code reviews, and development operations for the PyTorch ecosystem. It's deployed as a Next.js application on Vercel and integrates with multiple external services.

## Core Architecture

### Entry Points

- **Main Entry**: `lib/bot/index.ts:17` - Registers all bot modules with Probot
- **Command Handler**: `lib/bot/pytorchBot.ts:6` - Handles `@pytorchbot` commands via comments and reviews
- **Command Parser**: `lib/bot/cliParser.ts:15` - Parses bot commands using argparse-style CLI interface

### Command System

The bot supports these primary commands:

- **`merge`** - Merges PRs with approval validation and force-merge capabilities
- **`revert`** - Reverts merged PRs with classification tracking
- **`rebase`** - Rebases PRs onto target branches
- **`label`** - Adds labels with permission validation
- **`cherry-pick`** - Cherry-picks PRs to release branches
- **`drci`** - Updates Dr. CI status comments

### Permission System (`lib/bot/utils.ts:248`)

- **Write Permissions**: Admin/write collaborators can use force-merge, ignore-current flags
- **Rebase Permissions**: Write permissions OR non-first-time contributors
- **Workflow Permissions**: Write permissions OR users with approved pull runs
- **Authorization Tracking**: Uses GitHub's collaborator permission API

## Bot Modules

### Core Command Bots

- **pytorchBotHandler** (`lib/bot/pytorchBotHandler.ts:41`) - Central command processor
- **cliParser** (`lib/bot/cliParser.ts:7`) - Command-line interface parser

### Automation Bots

- **autoLabelBot** - Smart labeling based on file changes and patterns
- **autoCcBot** - Auto-CC users based on label subscriptions
- **retryBot** - Intelligent CI retry using flakiness analytics
- **ciflowPushTrigger** - Git tag management for CI flow triggers
- **cancelWorkflowsOnCloseBot** - Resource cleanup on PR closure

### CI Integration Bots

- **verifyDisableTestIssueBot** - Test disabling authorization

### Security & Review Bots

- **stripApprovalBot** - Removes approvals on PR reopen
- **codevNoWritePermBot** - Notifies about permission requirements
- **drciBot** - Dr. CI dashboard integration

### Infrastructure Bots

- **webhookToDynamo** - Event logging to DynamoDB
- **pytorchbotLogger** - Bot action logging

## Detailed Bot Analysis

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

## External Integrations

### Data Storage

- **DynamoDB**: Event logging, bot action tracking (`lib/bot/pytorchbotLogger.ts:4`)
- **ClickHouse**: CI analytics, flaky test data queries (`lib/bot/pytorchBotHandler.ts:5`)

### CI Systems

- **GitHub Actions**: Workflow triggering via repository dispatch events
- **CircleCI**: Parameter-based workflow triggering
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

## Data Flow

1. **GitHub Webhook** → **Probot App** → **Bot Module Router**
2. **Command Parsing** → **Permission Validation** → **Action Execution**
3. **External API Calls** (GitHub, CircleCI, ClickHouse)
4. **Event Logging** (DynamoDB) + **Response** (GitHub reactions/comments)

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

## Configuration Files

- `Constants.ts:1` - Cherry-pick and revert classifications
- `subscriptions.ts:1` - Label subscription parsing utilities
- Repository-specific configs loaded via `CachedConfigTracker`

This bot ecosystem provides comprehensive automation for the PyTorch development workflow, balancing developer productivity with security and code quality requirements through intelligent automation and robust permission systems.

# Autorevert Metrics Page Specification

## Overview

The autorevert metrics page (`/metrics/autorevert`) provides performance analytics for the PyTorch autorevert system. It tracks signal recovery events, attributes reverts to autorevert vs human, and identifies false positives.

## Key Concepts

### Signal Recovery Event

A signal recovery occurs when a job group (workflow + normalized job name) transitions from:

- **2+ consecutive red commits** → **2+ consecutive green commits**

The first green commit in the green streak is the "recovery commit".

### Revert Attribution

Recovery commits that are reverts (message starts with "Revert" or "Back out") are attributed to:

- **Autorevert**: The reverted commit SHA matches an entry in `autorevert_events_v2`
- **Human**: No matching autorevert event found

### False Positive Detection

A false positive is an autorevert that should NOT have happened. Detection criteria:

1. Autorevert event exists (commit was reverted by the system)
2. No signal recovery associated with the revert (the revert didn't fix any signals)
3. GitHub API verification confirms the original PR was merged without changes after revert

## Architecture

### Backend Endpoint: `/api/autorevert/metrics`

Single endpoint that provides all data for the page.

**Parameters:**

- `startTime` - Start of time range (DateTime64)
- `stopTime` - End of time range (DateTime64)
- `workflowNames` - Array of workflow names to analyze
- `minRedCommits` - Minimum red streak length (default: 2)
- `minGreenCommits` - Minimum green streak length (default: 2)

**Response:**

```typescript
{
  weeklyMetrics: WeeklyMetric[];
  significantReverts: SignificantRevert[];
  falsePositiveCandidates: FalsePositiveCandidate[];
  summary: {
    totalRevertRecoveries: number;
    autorevertRecoveries: number;
    humanRevertRecoveries: number;
    confirmedFalsePositives: number;
    autorevertRate: number;
    precision: number;
    recall: number;
  };
}
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ClickHouse Queries                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Base Query: Signal Recovery Events                                       │
│     - Identifies red→green transitions per job group                         │
│     - Filters by workflow names                                              │
│     - Returns recovery_sha for each recovery event                           │
│                                                                              │
│  2. Autorevert Events Query                                                  │
│     - Gets all autorevert events where hasAny(workflows, workflowNames)      │
│     - Links to revert commit via PR number + timestamp                       │
│     - Returns: reverted_sha, revert_commit_sha, pr_number, event_time        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Backend Processing                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  3. Join & Classify                                                          │
│     - Match autorevert revert_commit_sha against recovery_sha list           │
│     - If match: autorevert has signal recovery (True Positive)               │
│     - If no match: False Positive Candidate                                  │
│                                                                              │
│  4. GitHub API Verification (for FP candidates only)                         │
│     - Fetch original PR state and commit history                             │
│     - Classify as:                                                           │
│       - PR still open → Legit revert (author hasn't relanded)                │
│       - PR has commits after revert → Legit revert (author fixed issues)     │
│       - PR merged with no changes → Confirmed False Positive                 │
│                                                                              │
│  5. Calculate Metrics                                                        │
│     - Aggregate by week for charts                                           │
│     - Calculate precision/recall                                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Linking Autorevert Events to Revert Commits

The `autorevert_events_v2` table records when the system decides to revert, but doesn't directly store the resulting revert commit SHA.

**Linking Strategy:**

1. Extract PR number from the reverted commit's message (via push table)
2. Find revert commits in push table where:
   - Message matches `Revert%` or `Back out%`
   - Message mentions the PR number (e.g., `#12345` or `/pull/12345`)
   - Commit timestamp > autorevert event timestamp
3. Take the first (earliest) matching revert commit

```sql
-- Pseudocode for linking
WITH autorevert_with_pr AS (
    SELECT
        a.commit_sha AS reverted_sha,
        a.ts AS autorevert_time,
        a.workflows,
        -- Extract PR from reverted commit message
        extractPR(p.head_commit.message) AS pr_number
    FROM autorevert_events_v2 a
    JOIN push p ON p.head_commit.id = a.commit_sha
    WHERE hasAny(a.workflows, {workflowNames})
),
revert_commits AS (
    SELECT
        sha,
        timestamp,
        message,
        extractPR(message) AS mentioned_pr
    FROM push
    WHERE message LIKE 'Revert%' OR message LIKE 'Back out%'
),
linked AS (
    SELECT
        a.*,
        r.sha AS revert_commit_sha,
        row_number() OVER (
            PARTITION BY a.reverted_sha
            ORDER BY r.timestamp ASC
        ) AS rn
    FROM autorevert_with_pr a
    JOIN revert_commits r
        ON r.mentioned_pr = a.pr_number
        AND r.timestamp > a.autorevert_time
)
SELECT * FROM linked WHERE rn = 1
```

## Precision/Recall Metrics

### Definitions

**True Positive (TP):** Autorevert that successfully recovered a signal

- Autorevert event exists
- Revert commit appears in significant_reverts (has signal recovery)

**False Positive (FP):** Autorevert that didn't need to happen

- Autorevert event exists
- No signal recovery for the revert
- GitHub verification confirms: PR merged with no changes after revert

**False Negative (FN):** Human revert with signal recovery that autorevert should have caught

- Recovery event is a revert (human-initiated)
- Revert has signal recovery (appears in significant_reverts)
- No matching autorevert event
- This represents missed opportunities

**True Negative (TN):** Not directly measurable

- Commits that were correctly NOT reverted

### Formulas

```
Precision = TP / (TP + FP)
          = Autoreverts with signal recovery / All autoreverts

Recall = TP / (TP + FN)
       = Autorevert recoveries / All revert recoveries
```

### Weekly Metrics

For the chart, calculate per week:

- `autorevert_recoveries` (TP)
- `human_revert_recoveries` (potential FN)
- `non_revert_recoveries` (not relevant to autorevert)
- `false_positives` (FP - autoreverts without recovery)
- `precision` = TP / (TP + FP)
- `recall` = TP / (TP + FN)

## Database Tables

### `misc.autorevert_events_v2`

```sql
ts              DateTime        -- When autorevert decided to act
repo            String          -- 'pytorch/pytorch'
action          Enum            -- 'revert' | 'restart' | 'none'
commit_sha      FixedString(40) -- The reverted (bad) commit
workflows       Array(String)   -- Workflows that triggered the action
source_signal_keys Array(String) -- Signal keys that caused the action
dry_run         UInt8           -- 1 if dry run
failed          UInt8           -- 1 if action failed
```

### `push` (for commit data)

```sql
head_commit.id        String    -- Commit SHA
head_commit.timestamp DateTime  -- Commit time
head_commit.message   String    -- Commit message
repository.full_name  String    -- 'pytorch/pytorch'
ref                   String    -- 'refs/heads/main'
```

### `workflow_run` / `workflow_job` (for signal status)

Used to determine job pass/fail status per commit.

## UI Components

1. **Scalar Metrics** - Summary cards showing totals and rates
2. **Weekly Trend Chart** - Stacked bar chart with precision/recall overlay
3. **Significant Reverts Table** - List of reverts with signal recovery
4. **False Positives Table** - Verified false positives with GitHub data

## Caching Strategy

- ClickHouse queries: Rely on SWR client-side caching (5 min refresh)
- GitHub API calls: In-memory server-side cache with 10 min TTL
- Cache key includes all query parameters

## Implementation Status

- [x] Basic signal recovery detection
- [x] Revert attribution (autorevert vs human)
- [x] Weekly metrics aggregation
- [x] Significant reverts table
- [x] Workflow selection UI
- [x] Unified backend endpoint (`/api/autorevert/metrics`)
- [x] Autorevert → revert commit linking (via PR number + timestamp)
- [x] False positive detection (autoreverts without signal recovery)
- [x] GitHub API verification (PR state, merged status, commits after revert)
- [x] Precision/recall calculation
- [x] Weekly precision/recall chart

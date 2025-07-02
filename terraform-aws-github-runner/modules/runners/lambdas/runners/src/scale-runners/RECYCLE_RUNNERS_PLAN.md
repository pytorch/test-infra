# Recycle Runners Implementation Plan

## Overview
Create a new `recycle-runners` lambda that proactively recycles eligible runners every 5 minutes, removing recycling responsibility from `scaleUp()` and `scaleUpChron()`.

## Goals
- Proactive runner recycling on a scheduled basis (every 5 minutes)
- Remove recycling logic from scale-up functions 
- Independent operation with proper metrics tracking
- No retry logic - track failures but don't retry

## Commit Plan

### ✅ Commit 1: Extract reusable recycling logic from tryReuseRunner
**Message:** `runners: Extract reusable recycling logic from tryReuseRunner`
**Files:** `runners.ts`
**Status:** ✅ Complete
**Scope:** 
- Extract `performRunnerRecycling(runner, runnerParameters, metrics)` 
- Extract `isRunnerEligibleForRecycling(runner)` with time/tag checks
- Keep `tryReuseRunner()` intact but refactor to use extracted functions

### ✅ Commit 2: Add tests for extracted recycling functions  
**Message:** `runners: Add tests for extracted recycling functions`
**Files:** `runners.test.ts` (updates)
**Status:** ✅ Complete
**Scope:**
- Test `performRunnerRecycling()` function
- Test `isRunnerEligibleForRecycling()` function
- Mock AWS services appropriately

### ✅ Commit 3: Add RecycleRunnersMetrics class
**Message:** `runners: Add RecycleRunnersMetrics class`
**Files:** `metrics.ts`
**Status:** 🚧 In Progress
**Scope:**
- `export class RecycleRunnersMetrics extends Metrics`
- Standard metrics methods following `ScaleUpChronMetrics` pattern

### ✅ Commit 4: Create recycle-runners.ts with discovery logic
**Message:** `runners: Create recycle-runners with runner discovery logic`
**Files:** `recycle-runners.ts` (new)
**Status:** ⏳ Pending
**Scope:**
- File structure with imports and main function skeleton
- Runner discovery using `listRunners()` with appropriate filters
- Logic to extract runner configuration from tags

### ✅ Commit 5: Add tests for recycle-runners discovery logic
**Message:** `runners: Add tests for recycle-runners discovery logic`
**Files:** `recycle-runners.test.ts` (new)
**Status:** ⏳ Pending
**Scope:**
- Test runner discovery and filtering
- Test configuration extraction from runner tags
- Mock AWS services and dependencies

### ✅ Commit 6: Implement recycling loop and error handling
**Message:** `runners: Implement recycling loop and error handling`
**Files:** `recycle-runners.ts`
**Status:** ⏳ Pending
**Scope:**
- Main recycling loop using extracted functions
- Error handling (no retries, just logging)
- Metrics tracking for each recycling attempt

### ✅ Commit 7: Add tests for recycling loop
**Message:** `runners: Add tests for recycling loop and error handling`
**Files:** `recycle-runners.test.ts`
**Status:** ⏳ Pending
**Scope:**
- Test main recycling loop
- Test error scenarios and logging
- Test metrics tracking

### ✅ Commit 8: Add lambda entry point and handler
**Message:** `runners: Add recycle-runners lambda entry point`
**Files:** `lambda.ts`, `recycle-runners.ts`
**Status:** ⏳ Pending
**Scope:**
- Lambda handler function following `scaleUpChron` pattern
- Timeout handling and metrics cleanup
- Export in main lambda file

### ✅ Commit 9: Remove tryReuseRunner function entirely
**Message:** `runners: Remove tryReuseRunner function and calls`
**Files:** `runners.ts`, `scale-up.ts`, `scale-up-chron.ts`, related test files
**Status:** ⏳ Pending
**Scope:**
- Remove `tryReuseRunner()` function entirely
- Remove calls from scale-up functions
- Update any related error handling and metrics
- Update tests to remove references

## Implementation Notes

### Recyclable Runner Criteria
- Runners with both `GithubRunnerID` and `EphemeralRunnerFinished` tags
- Time-based filtering (same as current `tryReuseRunner()` logic)
- Must have org or repo information
- Must have region information

### Recycling Process
1. Find all eligible runners across all regions
2. For each runner, extract its current configuration from tags
3. Perform recycling operations (volume replacement, tag updates, SSM parameters)
4. Track metrics for success/failure
5. Continue processing other runners if one fails

### Error Handling
- No retries for failed recycling attempts
- Log all errors for debugging
- Track failure metrics
- Continue processing remaining runners

## Status Legend
- ⏳ Pending
- 🚧 In Progress  
- ✅ Complete
- ❌ Failed/Blocked

## Current Status
Ready to begin implementation with Commit 1. 
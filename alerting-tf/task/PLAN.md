# Alert Normalization Data Format Validation and Fixes

## Overview

This plan addresses data format validation issues found when comparing our implementation against real production data from AWS CloudWatch and Grafana alerts. The goal is to ensure our transformers work with actual data formats and fail fast when data doesn't match expected structures.

## Phase 1: CloudWatch Transformer Fixes

### Data Format Issues
- [ ] **Fix AlarmDescription parsing format**
  - Current: Parse pipe-separated `"TEAM=dev-infra | PRIORITY=P1 | RUNBOOK=https://..."`
  - New: Parse newline-separated `"Body of alarm.\\nStats:\\nTEAM=foobar\\nPriority=P1"`
  - Handle double-escaped newlines (`\\n`)
  - Separate description text from key=value pairs

- [ ] **Implement case-insensitive key matching**
  - Support `TEAM`, `Team`, `team`
  - Support `PRIORITY`, `Priority`, `priority`
  - Support `RUNBOOK`, `Runbook`, `runbook`
  - Support `DASHBOARD`, `Dashboard`, `dashboard`

- [ ] **Fix region extraction from ARN**
  - Extract region from `AlarmArn`: `arn:aws:cloudwatch:us-east-1:...` → `us-east-1`
  - Remove region name mapping (`"US East (N. Virginia)"` → `us-east-1`)
  - Update console URL generation to use ARN-extracted region

### Error Handling
- [ ] **Implement fail-fast error handling**
  - Throw descriptive errors when `AlarmName` missing
  - Throw descriptive errors when `AlarmDescription` unparseable
  - Throw descriptive errors when critical fields missing
  - Remove fallback to "unknown" team or "P3" priority

## Phase 2: Grafana Transformer Fixes

### Data Structure Issues
- [ ] **Fix priority extraction paths**
  - Current: Look in `labels.priority`
  - New: Look in `annotations.Priority`, `commonAnnotations.Priority`
  - Handle case variations (`Priority` vs `priority`)

- [ ] **Fix team extraction paths**
  - Current: Look in `labels.team`
  - New: Look in `annotations.Team`, `annotations.TEAM`, `commonAnnotations.Team`, `commonAnnotations.TEAM`

- [ ] **Add panelURL extraction**
  - Extract from `alerts[0].panelURL`
  - Add as optional field to AlertLinks interface
  - Update type definitions

- [ ] **Make dashboard/panel URLs optional**
  - Update AlertLinks interface to make all URL fields optional
  - Remove validation requirements for these fields

### Error Handling
- [ ] **Implement fail-fast error handling**
  - Throw descriptive errors when `alertname` missing
  - Throw descriptive errors when required annotations missing
  - Remove fallback logic for missing team/priority
  - Fail explicitly when data doesn't match expected format

## Phase 3: Type Definition Updates

- [ ] **Update AlertLinks interface**
  - Add `panelURL?: string` field
  - Ensure `runbook_url?`, `dashboard_url?`, `source_url?` are all optional
  - Update implementation to handle optional fields

- [ ] **Remove fallback constants**
  - Remove "unknown" team defaults
  - Remove "P3" priority defaults
  - Update validation logic to require critical fields

## Phase 4: Test Data Updates

### CloudWatch Test Data
- [ ] **Replace CloudWatch test payloads with real format**
  - Use actual alarm JSON from REFERENCE_DATA.md
  - Update `cloudwatch-alarm.json` with real `AlarmDescription` format
  - Update `cloudwatch-ok.json` with real data structure

### Grafana Test Data
- [ ] **Replace Grafana test payloads with real format**
  - Use actual annotation structure from REFERENCE_DATA.md
  - Update priority/team extraction paths in test files
  - Add panelURL field to test data

### Error Handling Tests
- [ ] **Remove fallback test cases**
  - Remove "missing team defaults to unknown" tests
  - Remove "missing priority defaults to P3" tests

- [ ] **Add failure test cases**
  - Test malformed CloudWatch alarms throw errors
  - Test malformed Grafana alerts throw errors
  - Test missing critical fields throw descriptive errors

## Phase 5: AlarmDescription Parser Rewrite

- [ ] **Create new parser for CloudWatch descriptions**
  - Split on `\n` instead of `|`
  - Handle double-escaped newlines (`\\n` → `\n`)
  - Case-insensitive key matching
  - Separate free-form description from structured key=value pairs
  - Return both description text and parsed metadata

- [ ] **Update parseAlarmDescription function**
  - Input: `"Body of alarm.\\n\\nCould be multi-line\\nTEAM=some-team\\nPRIORITY=P1\\nRUNBOOK=<url>"`
  - Output: `{ description: "Body of alarm.\n\nCould be multi-line", TEAM: "some-team", PRIORITY: "P1", RUNBOOK: "<url>" }`

## Phase 6: Address Existing TODOs

- [ ] **Find and fix TODO comments in lambda files**
  - Search for "TODO" in `alerting-tf/lambdas/collector/src/`
  - Implement proper error handling where TODOs indicate missing functionality
  - Replace placeholder logic with production-ready implementations

## Phase 7: Integration Testing and Validation

- [ ] **Update test script validation**
  - Remove fallback scenario testing
  - Add error case testing
  - Validate against real production data formats

- [ ] **Build and test with real data**
  - Build Lambda: `npm run build:test`
  - Run validation: `node test-normalization.js`
  - Test with actual CloudWatch and Grafana payloads from REFERENCE_DATA.md

- [ ] **Deploy and validate end-to-end**
  - Deploy infrastructure changes
  - Test with real SNS messages
  - Verify structured logging shows correct normalized alerts
  - Confirm error handling works as expected

## Implementation Notes

### Key Philosophy Changes
1. **Fail Fast**: Throw descriptive errors instead of using fallback values
2. **Real Data Formats**: Use actual production data structures, not assumed formats
3. **Case Insensitivity**: Handle various casing in CloudWatch key=value pairs
4. **Optional Fields**: Make non-critical fields truly optional (URLs, descriptions)

### Critical Success Criteria
- CloudWatch alarms with proper `AlarmDescription` format parse correctly
- Grafana alerts with annotations (not labels) for team/priority parse correctly
- Malformed data throws descriptive errors immediately
- All URLs (dashboard, panel, runbook) are optional and properly extracted when present
- Region codes extracted from ARNs, not display names

### Files to be Modified
- `alerting-tf/lambdas/collector/src/transformers/cloudwatch.ts`
- `alerting-tf/lambdas/collector/src/transformers/grafana.ts`
- `alerting-tf/lambdas/collector/src/types.ts`
- `alerting-tf/lambdas/collector/test-data/*.json`
- `alerting-tf/test-normalization.js`
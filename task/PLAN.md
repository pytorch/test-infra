# Alert Normalization Implementation Plan

## Overview

This plan implements a complete alert normalization system following the DESIGN.md specification. This is a **greenfield rewrite** - backward compatibility is not required.

## Example Payloads Reference

### AWS CloudWatch Alarm Notification Example

```json
{
  "Type": "Notification",
  "MessageId": "12345678-1234-1234-1234-123456789012",
  "TopicArn": "arn:aws:sns:us-east-1:123456789012:alerts",
  "Subject": "ALARM: Runners-ASG-InsufficientInstances in US East - N. Virginia",
  "Message": "{\"AlarmName\":\"Runners-ASG-InsufficientInstances\",\"AlarmDescription\":\"TEAM=dev-infra | PRIORITY=P1 | RUNBOOK=https://runbooks.example.org/asg-scaling\",\"AWSAccountId\":\"123456789012\",\"NewStateValue\":\"ALARM\",\"NewStateReason\":\"Threshold Crossed: 1 out of the last 1 datapoints [0.0 (05/01/23 19:10:00)] was less than the threshold (2.0).\",\"StateChangeTime\":\"2025-09-03T19:10:01.000Z\",\"Region\":\"US East - N. Virginia\",\"AlarmArn\":\"arn:aws:cloudwatch:us-east-1:123456789012:alarm:Runners-ASG-InsufficientInstances\",\"OldStateValue\":\"OK\",\"Trigger\":{\"MetricName\":\"GroupDesiredCapacity\",\"Namespace\":\"AWS/AutoScaling\",\"StatisticType\":\"Statistic\",\"Statistic\":\"AVERAGE\",\"Unit\":null,\"Dimensions\":[{\"name\":\"AutoScalingGroupName\",\"value\":\"gh-ci-canary\"}],\"Period\":300,\"EvaluationPeriods\":1,\"ComparisonOperator\":\"LessThanThreshold\",\"Threshold\":2.0,\"TreatMissingData\":\"\",\"EvaluateLowSampleCountPercentile\":\"\"}}",
  "Timestamp": "2025-09-03T19:10:01.123Z",
  "SignatureVersion": "1"
}
```

### Grafana Alert Webhook Example

```json
{
  "receiver": "sns",
  "status": "firing",
  "orgId": 1,
  "alerts": [
    {
      "status": "firing",
      "labels": {
        "alertname": "Runners Scale Up Failure",
        "team": "dev-infra",
        "priority": "P1",
        "resource_type": "runner",
        "resource_id": "gh-ci-canary"
      },
      "annotations": {
        "description": "GitHub runners failed to scale up in response to queue depth",
        "runbook_url": "https://runbooks.example.org/runners-scaling",
        "summary": "Runner scaling failure detected"
      },
      "startsAt": "2025-09-03T19:10:01.000Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "generatorURL": "https://grafana.example.com/graph/d/abc123/runners?orgId=1&tab=alert",
      "fingerprint": "abc123def456"
    }
  ],
  "groupLabels": {
    "alertname": "Runners Scale Up Failure"
  },
  "commonLabels": {
    "team": "dev-infra",
    "priority": "P1"
  },
  "commonAnnotations": {},
  "externalURL": "https://grafana.example.com",
  "version": "1",
  "groupKey": "{}:{alertname=\"Runners Scale Up Failure\"}",
  "truncatedAlerts": 0,
  "title": "[FIRING:1] Runners Scale Up Failure",
  "state": "alerting",
  "message": "**Firing**\n\nValue: [no value]\nLabels:\n - alertname = Runners Scale Up Failure\n - team = dev-infra\n - priority = P1"
}
```

## Pre-Implementation Setup

**NO SETUP REQUIRED** - Lambda timeout is already correctly set to 30 seconds

## Phase 1: Core Schema and Type Definitions

**File: `alerting-tf/lambdas/collector/src/types.ts` (NEW FILE)**
- [ ] Create TypeScript interfaces matching DESIGN.md section 6
- [ ] Define `Envelope` interface with these exact fields:
  - `received_at: string` (ISO8601 UTC)
  - `ingest_topic: string` (SNS topic name)
  - `ingest_region: string` (AWS region)
  - `delivery_attempt: number` (SQS receive count)
  - `event_id?: string` (optional provider ID)
- [ ] Define `AlertEvent` interface with these exact fields:
  - `schema_version: number` (start with 1)
  - `provider_version: string` (e.g. "grafana:9.5")
  - `source: "grafana" | "cloudwatch"`
  - `state: "FIRING" | "RESOLVED"`
  - `title: string`
  - `description?: string`
  - `priority: "P0" | "P1" | "P2" | "P3"`
  - `occurred_at: string` (ISO8601)
  - `team: string`
  - `resource` object with `type`, `id?`, `region?`, `extra?`
  - `identity` object with AWS/Grafana identifiers
  - `links` object with `runbook_url?`, `dashboard_url?`, `source_url?`
  - `raw_provider: any` (original payload)
- [ ] Define `AlertState` interface for DynamoDB records (section 10 of DESIGN.md)
- [ ] Export all interfaces from this file

**File: `alerting-tf/lambdas/collector/src/fingerprint.ts` (NEW FILE)**
- [ ] Create `generateFingerprint(alertEvent: AlertEvent): string` function
- [ ] Implement SHA-256 hash of sorted key-value pairs from DESIGN.md section 9:
  - `source`
  - `title` (normalized)
  - `resource.type` and `resource.id` if present
  - `identity.aws_account`, `identity.region`, `identity.alarm_arn` (CloudWatch)
  - `identity.org_id`, `identity.rule_id` (Grafana)
- [ ] Add helper function `sortAndHashObject(obj: Record<string, any>): string`
- [ ] Include unit tests in comments showing expected fingerprints for sample data

## Phase 2: Provider-Specific Transformers

**File: `alerting-tf/lambdas/collector/src/transformers/base.ts` (NEW FILE)**
- [ ] Create abstract `BaseTransformer` class
- [ ] Define `transform(rawPayload: any, envelope: Envelope): AlertEvent` abstract method
- [ ] Add helper methods:
  - `extractPriority(input: string): "P0" | "P1" | "P2" | "P3"` - parse P0-P3 from strings
  - `normalizeTitle(title: string): string` - clean/trim title
  - `parseTimestamp(input: string | Date): string` - convert to ISO8601

**File: `alerting-tf/lambdas/collector/src/transformers/grafana.ts` (NEW FILE)**
- [ ] Create `GrafanaTransformer extends BaseTransformer`
- [ ] Implement `transform()` method expecting Grafana webhook payload structure (see example above):
  - Extract `title` from `alerts[0].labels.alertname` or `title` field
  - Extract `state` from `status` field ("firing" → "FIRING", "resolved" → "RESOLVED")
  - Extract `priority` from `alerts[0].labels.priority` or `commonLabels.priority`
  - Extract `team` from `alerts[0].labels.team` or `commonLabels.team`
  - Extract `occurred_at` from `alerts[0].startsAt` or `alerts[0].endsAt`
  - Build `identity` object with `org_id`, `rule_id` from alert fingerprint
  - Extract dashboard URLs from `alerts[0].generatorURL` or `externalURL`
  - Set `provider_version` to "grafana:unknown" (can enhance later)
- [ ] Add validation: throw error if required fields missing
- [ ] Add fallback logic: if team/priority missing, use "unknown" team and "P3" priority

**File: `alerting-tf/lambdas/collector/src/transformers/cloudwatch.ts` (NEW FILE)**
- [ ] Create `CloudWatchTransformer extends BaseTransformer`
- [ ] Implement `transform()` method expecting CloudWatch alarm payload (see example above):
  - Parse SNS `Message` field as JSON first
  - Extract `title` from `AlarmName` field
  - Extract `state` from `NewStateValue` ("ALARM" → "FIRING", "OK" → "RESOLVED")
  - Extract `occurred_at` from `StateChangeTime`
  - Parse `AlarmDescription` for key-value pairs (DESIGN.md section 7):
    - Look for `TEAM=<team>`, `PRIORITY=<P0-P3>`, `RUNBOOK=<url>` patterns
  - Build `identity` object with `AWSAccountId`, `Region`, `AlarmArn`
  - Extract resource info from `Trigger.Dimensions` array
  - Set `provider_version` to "cloudwatch:2025-06"
- [ ] Add parsing helper: `parseAlarmDescription(desc: string): Record<string, string>`
- [ ] Add validation and fallbacks same as Grafana transformer

**File: `alerting-tf/lambdas/collector/src/transformers/index.ts` (NEW FILE)**
- [ ] Export all transformer classes
- [ ] Create `getTransformer(source: string): BaseTransformer` factory function
- [ ] Add source type detection logic (check SQS message attributes, then fallback to payload sniffing)

## Phase 3: Enhanced Alert Processing Pipeline

**File: `alerting-tf/lambdas/collector/src/processor.ts` (NEW FILE)**
- [ ] Create `AlertProcessor` class with these methods:
  - `processRecord(sqsRecord: SQSRecord): Promise<ProcessingResult>`
  - `buildEnvelope(sqsRecord: SQSRecord): Envelope`
  - `normalizeAlert(rawPayload: any, envelope: Envelope): AlertEvent`
  - `checkOutOfOrder(alertEvent: AlertEvent, fingerprint: string): Promise<boolean>`
  - `determineAction(alertEvent: AlertEvent, fingerprint: string): Promise<AlertAction>`
- [ ] Define `ProcessingResult` type with success/failure status and metadata
- [ ] Define `AlertAction` enum: "CREATE" | "COMMENT" | "CLOSE" | "SKIP_STALE" | "SKIP_MANUAL_CLOSE"
- [ ] Implement envelope building from SQS record metadata
- [ ] Add comprehensive error handling with structured logging
- [ ] Include audit logging for each processing step

**COMPLETE REWRITE: `alerting-tf/lambdas/collector/src/index.ts`**
- [ ] **REMOVE ALL EXISTING PROCESSING LOGIC** - this is a greenfield rewrite
- [ ] Replace entire handler with new normalization pipeline:
  - Import `AlertProcessor`, `generateFingerprint`, types
  - Create processor instance
  - For each SQS record:
    - Call `processor.processRecord(record)`
    - Generate fingerprint from normalized alert
    - Log the normalized `AlertEvent` as structured JSON
    - Store to DynamoDB using new schema
    - Create GitHub issue based on normalized data
- [ ] **REMOVE** the current title/body extraction logic (lines 129-139)
- [ ] **REMOVE** the current GitHub condition (`/github/i.test(title)`)
- [ ] Add structured logging of normalized alerts:
  ```typescript
  console.log("NORMALIZED_ALERT", {
    fingerprint,
    alertEvent,
    envelope,
    action: "determined_action"
  });
  ```
- [ ] Keep existing GitHub App authentication logic
- [ ] Keep existing error handling and batch failure reporting pattern

## Phase 4: Database Schema Updates

**COMPLETE REWRITE: `alerting-tf/infra/dynamodb.tf`**
- [ ] **REPLACE ENTIRE FILE** with new schema from DESIGN.md section 10:
  ```hcl
  resource "aws_dynamodb_table" "alerts_state" {
    name         = "${local.name_prefix}-alerts-state"  # Changed name
    billing_mode = "PAY_PER_REQUEST"

    hash_key = "fingerprint"  # Changed from "pk"

    attribute {
      name = "fingerprint"
      type = "S"
    }

    # Add attributes for GSI (even if not creating GSI yet)
    attribute {
      name = "team"
      type = "S"
    }

    attribute {
      name = "last_seen_at"
      type = "S"
    }

    ttl {
      attribute_name = "ttl_expires_at"
      enabled        = true
    }

    tags = var.tags
  }
  ```

**UPDATE: `alerting-tf/infra/lambda.tf`**
- [ ] Update environment variable to point to new table:
  ```hcl
  STATUS_TABLE_NAME = aws_dynamodb_table.alerts_state.name  # Changed reference
  ```

**File: `alerting-tf/lambdas/collector/src/database.ts` (NEW FILE)**
- [ ] Create `AlertStateManager` class with methods:
  - `loadState(fingerprint: string): Promise<AlertState | null>`
  - `saveState(fingerprint: string, alertEvent: AlertEvent, action: string): Promise<void>`
  - `updateState(fingerprint: string, updates: Partial<AlertState>): Promise<void>`
- [ ] Implement DynamoDB operations using existing client
- [ ] Add conditional writes to prevent race conditions
- [ ] Calculate and set TTL (3 years from now in epoch seconds)
- [ ] Map `AlertEvent` fields to DynamoDB record structure from DESIGN.md section 10

## Phase 5: Example Payloads and Testing

**Directory: `alerting-tf/lambdas/collector/test-data/` (NEW)**
- [ ] Create `grafana-firing.json` with realistic Grafana webhook payload:
  ```json
  {
    "receiver": "sns",
    "status": "firing",
    "alerts": [{
      "status": "firing",
      "labels": {
        "alertname": "Runners Scale Up Failure",
        "team": "dev-infra",
        "priority": "P1"
      },
      "startsAt": "2025-09-03T19:10:01.000Z"
    }]
  }
  ```
- [ ] Create `grafana-resolved.json` with `status: "resolved"` and `endsAt` timestamp
- [ ] Create `cloudwatch-alarm.json` with SNS message structure containing CloudWatch alarm JSON
- [ ] Create `cloudwatch-ok.json` with `NewStateValue: "OK"`
- [ ] Include edge cases: missing team, missing priority, malformed timestamps

**File: `alerting-tf/test-normalization.js` (NEW)**
- [ ] Create standalone test script that:
  - Loads test payloads from test-data directory
  - Simulates SQS record structure with message attributes
  - Calls transformer logic directly (import from dist/ after build)
  - Prints normalized AlertEvent JSON
  - Validates fingerprint generation
  - Checks for expected field values
  - Tests both Grafana and CloudWatch transformers

**Deployment and Validation**
- [ ] Build Lambda: `cd alerting-tf/lambdas/collector && npm run build`
- [ ] **DESTROY AND RECREATE** DynamoDB table: `cd alerting-tf && terraform destroy -target=aws_dynamodb_table.alerting_status && terraform apply`
- [ ] Deploy Lambda: `cd alerting-tf && make apply`
- [ ] Test with real SNS messages using test payloads
- [ ] Verify CloudWatch logs show structured `NORMALIZED_ALERT` entries
- [ ] Confirm new DynamoDB table has correct schema and data
- [ ] Validate fingerprint uniqueness across different alert variations

## Phase 6: Configuration and Routing (Future Sprint)

**Placeholder for Next Sprint**
- [ ] Add S3 config loading for team routing (per DESIGN.md section 8)
- [ ] Implement priority override logic
- [ ] Add label management for GitHub issues
- [ ] Enhance alert lifecycle management (OPEN/CLOSED states)

## Implementation Notes for Junior Developer

### Critical Requirements

1. **THIS IS A COMPLETE REWRITE** - don't preserve existing logic, build from scratch
2. **All dates must be ISO8601 UTC format** - use `new Date().toISOString()`
3. **All errors must be logged with context** - include fingerprint, message ID, error details
4. **Follow existing code patterns** - use same imports, error handling, async/await style
5. **Test each phase independently** - don't move to next phase until current one works

### What TO CHANGE (No Backward Compatibility Needed)

- Replace entire alert processing pipeline
- Change DynamoDB table schema completely
- Change GitHub issue creation logic to use normalized data
- Remove the `/github/i.test()` condition - create issues for all alerts initially

### What NOT TO CHANGE

- Lambda environment variables names
- SNS message attribute names (`source: "grafana"`)
- GitHub App authentication flow
- SQS event source mapping configuration
- Overall Lambda handler signature and batch failure reporting

### Reference Materials

- Use the example payloads above as test data
- Follow DESIGN.md sections 6-10 for exact schema specifications
- Ensure fingerprints are deterministic (same input = same fingerprint always)

### Validation Checklist for Each Phase

- Code compiles without TypeScript errors
- Lambda deploys successfully
- CloudWatch logs show expected normalized output format
- DynamoDB records match the new schema
- Fingerprints are stable and unique

### Common Pitfalls to Avoid

- Don't change DynamoDB table name or Lambda environment variables
- Don't modify the SQS event source mapping configuration
- Don't alter the existing GitHub App authentication flow
- Don't change the SNS message attribute names (`source: "grafana"`)
- Ensure fingerprints are deterministic (same input = same fingerprint always)
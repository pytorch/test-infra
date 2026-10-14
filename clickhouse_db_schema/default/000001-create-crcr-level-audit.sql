-- noqa: disable=CP05,LT01
-- Durable CRCR configured-level decision audit. This is append-only: a bot
-- proposal and its later applied, closed, or superseded outcome are separate
-- facts linked by decision_id. Unlike crcr_workflow_job, this ledger has no
-- TTL because it explains long-lived configuration changes.
CREATE TABLE crcr_level_audit
(
    `event_id` UUID COMMENT 'Unique immutable audit event ID',
    `decision_id` UUID COMMENT 'Stable ID shared by all lifecycle events for one proposed change',
    `downstream_repo` LowCardinality(String) COMMENT 'CRCR backend repository in owner/repo form',
    `previous_level` String DEFAULT '' COMMENT 'Configured level before the change; empty for initial onboarding',
    `new_level` LowCardinality(String) COMMENT 'Configured level proposed or applied by this decision',
    `decision_kind` Enum8('promotion' = 1, 'demotion' = 2, 'initial' = 3) COMMENT 'Direction of the configured-level decision',
    `decision_source` Enum8('automation' = 1, 'maintainer' = 2, 'onboarding' = 3) COMMENT 'Who made the decision',
    `event_state` Enum8('proposed' = 1, 'applied' = 2, 'closed' = 3, 'superseded' = 4) COMMENT 'Lifecycle state recorded by this immutable event',
    `evaluation_window_start` Nullable(DateTime64(3)) COMMENT 'Start of the fixed metrics window for automated decisions',
    `evaluation_window_end` Nullable(DateTime64(3)) COMMENT 'End of the fixed metrics window for automated decisions',
    `criteria_snapshot_json` String DEFAULT '' COMMENT 'Versioned JSON snapshot of thresholds, observed values, and verdicts',
    `reason` String DEFAULT '' COMMENT 'Failed criterion explanation or required manual decision justification',
    `proposal_pr_url` String DEFAULT '' COMMENT 'Bot or maintainer configuration proposal pull request',
    `approval_pr_url` String DEFAULT '' COMMENT 'Review or approval record for a manual decision when separate',
    `configuration_commit_sha` String DEFAULT '' COMMENT 'Merged allowlist/configuration commit for applied decisions',
    `recorded_by` LowCardinality(String) COMMENT 'Trusted workflow or service that emitted this audit event',
    `recorded_at` DateTime64(3) COMMENT 'When the writer recorded this lifecycle event',
    `effective_at` Nullable(DateTime64(3)) COMMENT 'When the configured level became effective; set only for applied events',
    `criteria_schema_version` UInt16 DEFAULT 1 COMMENT 'Criteria snapshot schema version',
    `_inserted_at` DateTime MATERIALIZED now()
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY (downstream_repo, recorded_at, event_id)
SETTINGS index_granularity = 8192;

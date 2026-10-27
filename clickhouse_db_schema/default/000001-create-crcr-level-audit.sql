-- noqa: disable=CP05,LT01
-- Durable CRCR configured-level decision audit. Lifecycle events are
-- append-only facts linked by decision_id. event_id and recorded_at are
-- generated once per transition and reused verbatim on writer retry; the
-- replacing key collapses duplicate delivery of the same lifecycle state.
-- Readers use FINAL or an equivalent argMax(recorded_at) deduplication until
-- background merges have collapsed retry duplicates.
-- Unlike crcr_workflow_job, this ledger has no TTL because it explains
-- long-lived configuration changes.
CREATE TABLE crcr_level_audit
(
    `event_id` UUID COMMENT 'Deterministic UUIDv5 idempotency key for decision_id and event_state',
    `decision_id` UUID COMMENT 'Stable ID shared by all lifecycle events for one proposed change',
    `superseded_by_decision_id` Nullable(UUID) COMMENT 'Replacement decision for a superseded event; null otherwise',
    `downstream_repo` LowCardinality(String) COMMENT 'CRCR backend repository in owner/repo form',
    `previous_level` LowCardinality(String) DEFAULT '' COMMENT 'Configured level before the change; empty for initial onboarding',
    `new_level` LowCardinality(String) COMMENT 'Configured level proposed or applied by this decision',
    `decision_kind` Enum8('promotion' = 1, 'demotion' = 2, 'initial' = 3) COMMENT 'Direction of the configured-level decision',
    `decision_source` Enum8('automation' = 1, 'maintainer' = 2, 'onboarding' = 3) COMMENT 'Who made the decision',
    `event_state` Enum8('proposed' = 1, 'applied' = 2, 'closed' = 3, 'superseded' = 4) COMMENT 'Lifecycle state recorded by this immutable event',
    `evaluation_window_start` Nullable(DateTime64(3, 'UTC')) COMMENT 'Start of the fixed metrics window for automated decisions',
    `evaluation_window_end` Nullable(DateTime64(3, 'UTC')) COMMENT 'End of the fixed metrics window for automated decisions',
    `criteria_snapshot_json` String DEFAULT '' COMMENT 'Versioned JSON snapshot of thresholds, observed values, and verdicts',
    `reason` String DEFAULT '' COMMENT 'Failed criterion explanation or required manual decision justification',
    `proposal_pr_url` String DEFAULT '' COMMENT 'Bot or maintainer configuration proposal pull request',
    `approval_pr_url` String DEFAULT '' COMMENT 'Review or approval record for a manual decision when separate',
    `configuration_commit_sha` String DEFAULT '' COMMENT 'Merged allowlist/configuration commit for applied decisions',
    `configuration_commit_url` String DEFAULT '' COMMENT 'Canonical link to the applied allowlist/configuration commit',
    `decision_actor` String DEFAULT '' COMMENT 'Maintainer or service principal responsible for the decision',
    `recorded_by` LowCardinality(String) COMMENT 'Trusted workflow or service that emitted this audit event',
    `recorded_at` DateTime64(3, 'UTC') COMMENT 'When this lifecycle event was first recorded; preserved on retry',
    `effective_at` Nullable(DateTime64(3, 'UTC')) COMMENT 'When the configured level became effective; set only for applied events',
    `criteria_schema_version` UInt16 DEFAULT 0 COMMENT 'Criteria snapshot schema version; zero when no snapshot exists',
    `_inserted_at` DateTime('UTC') MATERIALIZED now(),
    CONSTRAINT audit_new_level CHECK new_level != '',
    CONSTRAINT audit_initial_level_shape CHECK (decision_kind = 'initial') = (previous_level = ''),
    CONSTRAINT audit_onboarding_source CHECK (decision_kind = 'initial') = (decision_source = 'onboarding'),
    CONSTRAINT audit_criteria_version CHECK (criteria_snapshot_json = '') = (criteria_schema_version = 0),
    CONSTRAINT audit_automated_evidence CHECK decision_source != 'automation' OR (isNotNull(evaluation_window_start) AND isNotNull(evaluation_window_end) AND criteria_snapshot_json != '' AND criteria_schema_version > 0),
    CONSTRAINT audit_manual_reason CHECK decision_source != 'maintainer' OR reason != '',
    CONSTRAINT audit_manual_approval CHECK event_state != 'applied' OR decision_source != 'maintainer' OR approval_pr_url != '',
    CONSTRAINT audit_applied_effective_at CHECK (event_state = 'applied') = isNotNull(effective_at),
    CONSTRAINT audit_applied_configuration CHECK event_state != 'applied' OR (configuration_commit_sha != '' AND configuration_commit_url != ''),
    CONSTRAINT audit_nonapplied_configuration CHECK event_state = 'applied' OR (configuration_commit_sha = '' AND configuration_commit_url = ''),
    CONSTRAINT audit_supersession_link CHECK (event_state = 'superseded') = isNotNull(superseded_by_decision_id)
)
ENGINE = ReplacingMergeTree(recorded_at)
ORDER BY (downstream_repo, decision_id, event_state)
SETTINGS index_granularity = 8192;

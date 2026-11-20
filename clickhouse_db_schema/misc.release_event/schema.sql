-- PyTorch Release Portal: the state of each release step, one row per observation.
--
-- Append-only. The collector (a scheduled GitHub workflow) writes one row per step on
-- every run, even when nothing changed, so `observed_at` doubles as "last checked".
-- Release pipelines (RC build, validation) write their own outcomes with
-- source = 'release_pipeline'.
--
-- The current state of a step is the latest row for (release, step_id, rc):
--
--   SELECT release, step_id, rc,
--          argMax(status, observed_at) AS status,
--          argMax(blocking, observed_at) AS blocking,
--          argMax(evidence_text, observed_at) AS evidence_text,
--          argMax(evidence_url, observed_at) AS evidence_url,
--          max(observed_at) AS last_checked
--   FROM misc.release_event
--   WHERE release = {release: String}
--   GROUP BY release, step_id, rc
--
-- A step that is not RC-scoped always has rc = ''. An RC-scoped step is a separate
-- series for each RC, so cutting a new RC starts every such step again at 'todo'
-- (the board reads the series of the current RC).
--
-- A re-run of the same workflow run replaces its own rows rather than duplicating
-- them: the sorting key ends in (source, run_id) and `observed_at` is the version.
-- Read with argMax as above, not FINAL.
CREATE TABLE misc.release_event
(
    -- Release version as in the release config, e.g. '2.16.0'.
    `release` LowCardinality(String),
    -- Step id from the release config, e.g. '2.3'.
    `step_id` LowCardinality(String),
    -- RC the observation is for, e.g. 'rc9'; '' for a step that is not RC-scoped.
    `rc` LowCardinality(String) DEFAULT '',
    -- The four states the board shows. Extending the list (stale, needs_human) is an ALTER.
    `status` Enum8('todo' = 0, 'in_progress' = 1, 'blocked' = 2, 'done' = 3),
    -- 1 when this observation should count as blocking the go/no-go call.
    `blocking` UInt8 DEFAULT 0,
    -- One line shown in the row, and the link behind it.
    `evidence_text` String DEFAULT '',
    `evidence_url` String DEFAULT '',
    -- Which kind of check produced the row (a check type from the release config).
    `check_type` LowCardinality(String) DEFAULT '',
    -- Who wrote it: 'collector', 'release_pipeline' or 'backfill'.
    `source` LowCardinality(String),
    -- The workflow run that wrote it (run id and attempt, e.g. '12345-1'); 'backfill' for a backfill.
    `run_id` String DEFAULT '',
    `run_url` String DEFAULT '',
    -- Git sha of the release config the collector read.
    `config_sha` FixedString(40) DEFAULT '0000000000000000000000000000000000000000',
    -- Check-specific JSON that does not belong in a column (counts, ids, raw response summary).
    `details` String DEFAULT '',
    `observed_at` DateTime64(3) DEFAULT now64(3),
    `_inserted_at` DateTime MATERIALIZED now()
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', observed_at)
ORDER BY (release, step_id, rc, source, run_id)
SETTINGS index_granularity = 8192

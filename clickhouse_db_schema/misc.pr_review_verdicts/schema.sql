-- Telemetry for the hardened PR review (pytorch/ciforge, moving to pytorch/pytorch).
--
-- TWO ROWS PER REVIEW ATTEMPT, and the pair is what makes the record readable:
--   `started`  - written by the prepare job before any model call, so an attempt
--                that is cancelled or dies on the runner still leaves a trace.
--   terminal   - written by the publish job under `if: always()`.
-- Three distinguishable states follow, which one row cannot express: no rows =
-- never triggered; started only = cancelled/superseded/runner died; both = the
-- attempt ran and `status` says how it ended.
--
-- COLUMN ORDER IS LOAD-BEARING. The S3 replicator inserts positionally
-- (`insert into <table> select *, (...) as _meta from s3(...)`), so this order
-- must stay byte-for-byte in step with the schema string in
-- `aws/lambda/clickhouse-replicator-s3/lambda_function.py`. Appending a column
-- here without adding it there, in the same position, shifts every later value.
--
-- The started row carries 20 of these 33 fields. The remaining 13 rely on
-- ClickHouse filling defaults for omitted JSON keys, and `verdict` is emitted as
-- an explicit JSON `null` on the started row, which relies on nulls becoming
-- defaults. Both are ClickHouse defaults
-- (`input_format_defaults_for_omitted_fields`, `input_format_null_as_default`)
-- but NEITHER was verified against this cluster - the author holds no INSERT
-- grant. Confirm on the first real insert before trusting the started rows.
CREATE TABLE misc.pr_review_verdicts
(
    -- Row identity and provenance.
    `schema_version` UInt16,
    `phase` LowCardinality(String),
    -- `gha-interim` now, `sandbox` after the credential-less harness replaces
    -- it. Both write this same shape so the two eras stay comparable.
    `harness` LowCardinality(String),
    `harness_version` String,
    `repo` LowCardinality(String),
    `pr_number` Int64,
    `head_sha` String,
    `base_sha` String,
    `is_fork` Bool,
    `trigger_event` LowCardinality(String),
    `trigger_label` String,
    `trigger_run_id` Int64,
    `review_run_id` Int64,
    `review_run_attempt` Int32,
    -- Hash of the trusted prompt/schema/sanitizer files, so a verdict can be
    -- attributed to the exact rubric that produced it.
    `prompt_hash` String,
    `trusted_sha` String,
    `timestamp` DateTime64(3),
    -- succeeded | schema_invalid | sanitizer_rejected | model_error | started
    `status` LowCardinality(String),
    -- Populated ONLY when status = 'succeeded'. A failed review must never
    -- surface as an objection: a reader cannot otherwise tell a real finding
    -- from an infrastructure hiccup.
    `verdict` LowCardinality(String),

    -- Terminal-only below this line; defaulted on the `started` row.
    --
    -- MODEL-INFLUENCED, and the only fields here that are. `summary` is
    -- sanitized and length-capped upstream but is still derived from a model
    -- reading attacker-authored code. Treat it as untrusted text on render -
    -- do not interpolate it into HTML, shell or SQL.
    `summary` String,
    `findings_count` Int32,
    `findings_dropped` Int32,
    `failure_detail` String,
    -- s3:// URI of the raw model transcript under `pr_review_traces/`. That
    -- prefix is deliberately NOT replicated into ClickHouse: it is unsanitized
    -- model output, and the untrusted review role can overwrite any key under
    -- it. Never join it to these rows as though it were authenticated.
    `reasoning_uri` String,
    `duration_ms` Int64,
    `num_turns` Int32,
    `total_cost_usd` Float64,
    `input_tokens` Int64,
    `output_tokens` Int64,
    `cache_read_input_tokens` Int64,
    `cache_creation_input_tokens` Int64,
    `model` String,
    -- Escape hatch, so a new field does not need the table re-cut.
    `extra` Map(String, String),

    `_meta` Tuple(bucket String, key String),
    `_inserted_at` DateTime MATERIALIZED now()
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
-- Identity of one attempt, with `phase` last so the started/terminal pair sits
-- adjacent. docs/hardened-pr-review.md in pytorch/ciforge proposed
-- `(repo, pr_number, head_sha, run_id, run_attempt)`; those last two names do
-- not exist in the emitted row, and without `phase` the two rows of a pair
-- share an identical key. Settle this before the table is created - adding a
-- column later is trivial, changing the sort key is not.
ORDER BY (repo, pr_number, head_sha, review_run_id, review_run_attempt, phase)
SETTINGS index_granularity = 8192

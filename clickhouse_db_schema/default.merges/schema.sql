-- Written by trymerge.py (pytorch/pytorch) as a JSON object per merge attempt,
-- uploaded to S3 and ingested by aws/lambda/clickhouse-replicator-s3.
--
-- `ai_not_related_checks` is added by 001_alter_add_ai_not_related_checks.sql
-- in this directory; the rest of this file is the table as it stands today.
CREATE TABLE default.merges
(
    `_id` String,
    `author` String,
    `broken_trunk_checks` Array(Array(String)),
    `comment_id` Int64,
    `dry_run` Bool,
    `error` String,
    `failed_checks` Array(Array(String)),
    `flaky_checks` Array(Array(String)),
    `ignore_current` Bool,
    `ignore_current_checks` Array(Array(String)),
    `is_failed` Bool,
    `last_commit_sha` String,
    `merge_base_sha` String,
    `merge_commit_sha` String,
    `owner` String,
    `pending_checks` Array(Array(String)),
    `pr_num` Int64,
    `project` String,
    `skip_mandatory_checks` Bool,
    `unstable_checks` Array(Array(String)),
    `ai_not_related_checks` Array(Array(String)),
    `_meta` Tuple(
        bucket String,
        key String)
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY (pr_num, _id)
SETTINGS index_granularity = 8192

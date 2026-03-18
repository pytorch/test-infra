CREATE TABLE vllm.vllm_buildkite_builds (
    dynamoKey String,
    build Tuple(
        finished_at Nullable(DateTime64(3)),
        graphql_id String,
        commit String,
        created_at DateTime64(3),
        scheduled_at Nullable(DateTime64(3)),
        source String,
        branch String,
        blocked_state String,
        cluster_url String,
        number UInt32,
        cluster_id String,
        blocked Bool,
        meta_data String,
        id String,
        state String,
        tag Nullable(String),
        creator Tuple(
            name Nullable(String),
            created_at Nullable(DateTime64(3)),
            id Nullable(String),
            avatar_url Nullable(String),
            graphql_id Nullable(String),
            email Nullable(String)
        ),
        pull_request Tuple(
            id Nullable(String),
            repository Nullable(String),
            base Nullable(String),
            labels Array(String)
        ),
        author Tuple(
            name String,
            email String,
            username String
        ),
        message String,
        rebuilt_from Nullable(String),
        url String,
        cancel_reason Nullable(String),
        web_url String,
        started_at Nullable(DateTime64(3))
    ),
    event String,
    pipeline Tuple(
        allow_rebuilds Bool,
        running_jobs_count UInt32,
        emoji String,
        color Nullable(String),
        graphql_id String,
        configuration String,
        description String,
        created_at DateTime64(3),
        skip_queued_branch_builds Bool,
        repository String,
        pipeline_template_uuid Nullable(String),
        cluster_url String,
        skip_queued_branch_builds_filter String,
        cluster_id String,
        cancel_running_branch_builds Bool,
        provider Tuple(
            webhook_url String,
            settings String,
            id String
        ),
        waiting_jobs_count UInt32,
        id String,
        slug String,
        badge_url String,
        visibility String,
        archived_at Nullable(DateTime64(3)),
        scheduled_jobs_count UInt32,
        running_builds_count UInt32,
        env Nullable(String),
        created_by Tuple(
            name Nullable(String),
            created_at Nullable(DateTime64(3)),
            id Nullable(String),
            avatar_url Nullable(String),
            graphql_id Nullable(String),
            email Nullable(String)
        ),
        steps String,
        url String,
        tags Nullable(String),
        scheduled_builds_count UInt32,
        builds_url String,
        web_url String,
        name String,
        default_branch String,
        branch_configuration Nullable(String),
        cancel_running_branch_builds_filter Nullable(String)
    ),
    sender Tuple(
        name Nullable(String),
        id Nullable(String)
    )
) ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY (
    pipeline.repository,
    pipeline.name,
    build.number,
    dynamoKey
)
SETTINGS index_granularity = 8192

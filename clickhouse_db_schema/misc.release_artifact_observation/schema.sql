-- PyTorch Release Portal: what the collector found for each expected release artifact.
--
-- One row per expected artifact per collector run. The expectations come from the
-- release build matrix (accelerator x python x os x arch x package type, per channel);
-- the observations from the download.pytorch.org index, the PyPI JSON API and the
-- Docker Hub tag list. A row for an artifact that exists but was not expected has
-- verdict = 'unexpected'.
--
-- The latest observation of an artifact is the latest row for its coordinates:
--
--   SELECT release, channel, package_type, project, accelerator, python, os, arch,
--          argMax(verdict, observed_at) AS verdict,
--          argMax(size_bytes, observed_at) AS size_bytes,
--          argMax(vs_previous_pct, observed_at) AS vs_previous_pct
--   FROM misc.release_artifact_observation
--   WHERE release = {release: String}
--   GROUP BY release, channel, package_type, project, accelerator, python, os, arch
--
-- A re-run of the same workflow run replaces its own rows (sorting key ends in run_id,
-- `observed_at` is the version). Read with argMax, not FINAL.
CREATE TABLE misc.release_artifact_observation
(
    `release` LowCardinality(String),
    -- 'test' for release candidates, 'release' for the final artifacts.
    `channel` LowCardinality(String),
    -- The RC the observation is for ('' for the release channel).
    `rc` LowCardinality(String) DEFAULT '',
    -- 'wheel', 'libtorch' or 'docker'.
    `package_type` LowCardinality(String),
    -- The package: 'torch', 'torchvision', 'torchaudio', 'libtorch', ...
    `project` LowCardinality(String),
    -- 'cpu', 'cu130', 'rocm7.1', 'xpu', ...
    `accelerator` LowCardinality(String),
    -- '3.11', '3.14t', ... ('' for a libtorch or docker artifact).
    `python` LowCardinality(String) DEFAULT '',
    -- 'linux', 'windows' or 'macos'.
    `os` LowCardinality(String),
    -- 'x86_64', 'aarch64' or 'arm64'.
    `arch` LowCardinality(String),
    `verdict` Enum8('present' = 0, 'missing' = 1, 'size_anomalous' = 2, 'unexpected' = 3),
    -- Where the artifact should be, and where it was seen (empty when missing).
    `expected_url` String DEFAULT '',
    `observed_url` String DEFAULT '',
    -- The HTTP status of the check (404 for a missing wheel); NULL when none was made.
    `http_status` Nullable(UInt16),
    `size_bytes` Nullable(UInt64),
    -- The same artifact in the previous release, and the change against it in percent.
    `previous_size_bytes` Nullable(UInt64),
    `vs_previous_pct` Nullable(Float32),
    -- 'download.pytorch.org', 'pypi' or 'dockerhub'.
    `source` LowCardinality(String),
    `run_id` String DEFAULT '',
    `run_url` String DEFAULT '',
    `observed_at` DateTime64(3) DEFAULT now64(3),
    `_inserted_at` DateTime MATERIALIZED now()
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', observed_at)
ORDER BY (release, channel, package_type, project, accelerator, python, os, arch, run_id)
SETTINGS index_granularity = 8192

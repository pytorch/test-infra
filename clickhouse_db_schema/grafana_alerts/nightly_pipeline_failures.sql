-- Alert when the nightly binary build pipeline has failures.
--
-- The nightly binary builds (manywheel / libtorch / conda, across
-- linux / linux-aarch64 / windows / macos / s390x) run on the `nightly` branch,
-- e.g. workflow `linux-aarch64-binary-manywheel`, job `manywheel-cpu-aarch64-build`.
-- This counts jobs from those workflows that completed with a failure in the
-- evaluation window; the Grafana alert fires when the count is > 0.
--
-- Used by Grafana alert: <add URL after creating the rule in pytorchci.grafana.net>
SELECT count() AS failed_nightly_jobs
FROM default.workflow_job
WHERE
    head_branch = 'nightly'
    AND workflow_name LIKE '%-binary-%'
    AND status = 'completed'
    AND conclusion = 'failure'
    AND completed_at >= now() - INTERVAL 24 HOUR

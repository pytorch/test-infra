-- One row per test case in a job_trace trace, for Perfetto's Query (SQL) page.
-- Test cases are the slices whose category is an outcome. Their parent is the
-- suite or the report (file); tests split out of parallel reports sit at
-- depth 0 and carry file, suite and owners as args.
CREATE OR REPLACE PERFETTO VIEW test_cases AS
SELECT
  s.id AS slice_id, s.ts, s.dur, s.track_id,
  pr.name AS shard,
  t.name AS lane,
  COALESCE(
    CASE WHEN p1.category = 'report' THEN p1.name WHEN p2.category = 'report' THEN p2.name END,
    EXTRACT_ARG(s.arg_set_id, 'args.file')) AS file,
  COALESCE(
    CASE WHEN p1.category = 'suite' THEN p1.name END,
    EXTRACT_ARG(s.arg_set_id, 'args.suite')) AS suite,
  s.name AS test,
  s.category AS outcome,
  EXTRACT_ARG(s.arg_set_id, 'args.rerun_number') AS rerun_number,
  COALESCE(
    EXTRACT_ARG(CASE WHEN p1.category = 'report' THEN p1.arg_set_id ELSE p2.arg_set_id END, 'args.owners'),
    EXTRACT_ARG(s.arg_set_id, 'args.owners')) AS owners,
  s.dur / 1e9 AS seconds
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t USING (utid)
JOIN process pr USING (upid)
LEFT JOIN slice p1 ON p1.id = s.parent_id
LEFT JOIN slice p2 ON p2.id = p1.parent_id
WHERE s.category IN ('passed', 'failed', 'error', 'skipped', 'xfailed', 'xpassed', 'crashed', 'timed_out', 'unknown');

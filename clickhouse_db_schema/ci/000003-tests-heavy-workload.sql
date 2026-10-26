-- noqa: disable=CP05,LT01
-- Queue heavy tests API queries so a burst waits instead of competing with
-- the rest of HUD. A query opts in with SETTINGS profile = 'tests_heavy'.
-- Queries that set no workload stay unscheduled: no `default` workload exists
-- and throw_on_unknown_workload is 0.
--
-- Limits are per replica: 2 running, 4 waiting; past that a query fails at
-- once with SERVER_OVERLOADED. The queue caps how many queries wait, not for
-- how long: 26.6 has no admission timeout. Sizing (2026-10-26): an
-- unfiltered list page costs ~31 CPU-s and takes ~8 s at max_threads = 4,
-- so the two slots use about 8 of a replica's 30 vCPUs.
--
-- These objects are server-wide, not part of the ci database, so a sandbox
-- run of this file creates them for real. Every statement is safe to re-run.
-- To lift the concurrency and queue limits without breaking callers that
-- still pass the profile (its thread, time and memory caps stay):
--   CREATE OR REPLACE WORKLOAD tests_heavy IN all;

CREATE RESOURCE IF NOT EXISTS query (QUERY);

CREATE WORKLOAD IF NOT EXISTS all;

CREATE OR REPLACE WORKLOAD tests_heavy IN all
SETTINGS max_concurrent_queries = 2, max_waiting_queries = 4;

CREATE SETTINGS PROFILE IF NOT EXISTS tests_heavy;

ALTER SETTINGS PROFILE tests_heavy
SETTINGS
    workload = 'tests_heavy',
    max_threads = 4,
    max_execution_time = 30,
    max_memory_usage = 4000000000;

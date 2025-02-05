import argparse
import datetime
import threading
import os
from typing import Dict, Iterable, List, Optional, Set
import clickhouse_connect
import time
import yaml

from dateutil import parser as dateutil_parser
from github import Github, Auth
from multiprocessing.pool import ThreadPool


import dateutil.parser
from github import Github


class LazyFileHistory:
    '''
    Reads the content of a file from a GitHub repository on the version that it was on a specific time and date provided. It then caches the commits and file contents avoiding unnecessary requests to the GitHub API.
    All public methods are thread-safe.
    '''
    def __init__(self, repo: any, path: str) -> None:
        self.repo = repo
        self.path = path
        self._commits_cache = []
        self._content_cache = {}
        self._fetched_all_commits = False
        self._lock = threading.RLock()

    def get_version_after_timestamp(self, timestamp: str | datetime.datetime) -> Optional[str]:
        try:
            with self._lock:
                if not isinstance(timestamp, datetime.datetime):
                    timestamp = dateutil.parser.parse(timestamp)

                commit = self._find_earliest_after_in_cache(timestamp)
                if commit:
                    return self._fetch_content_for_commit(commit)

                if not self._fetched_all_commits:
                    commit = self._fetch_until_timestamp(timestamp)
                    if commit:
                        return self._fetch_content_for_commit(commit)
        except Exception as e:
            self._content_cache[commit.sha] = '{"runner_types": {}}'
            print(f"Error fetching content for {self.repo} : {self.path} at {timestamp}: {e}")

        return None

    def _find_earliest_after_in_cache(self, timestamp: datetime.datetime) -> Optional[str]:
        commits_after = [
            c for c in self._commits_cache
            if c.commit.author.date > timestamp
        ]
        if not commits_after:
            return None
        return commits_after[-1]

    def _fetch_until_timestamp(self, timestamp: datetime.datetime) -> str:
        all_commits = self.repo.get_commits(path=self.path)
        known_shas = {c.sha for c in self._commits_cache}

        newly_fetched = []

        for commit in all_commits:
            if commit.sha in known_shas:
                break
            newly_fetched.append(commit)

            if commit.commit.author.date <= timestamp:
                break

        self._commits_cache.extend(newly_fetched)
        self._commits_cache.sort(key=lambda c: c.commit.author.date, reverse=True)

        if not newly_fetched:
            self._fetched_all_commits = True

        return self._find_earliest_after_in_cache(timestamp)

    def _fetch_content_for_commit(self, commit: any) -> str:
        if commit.sha not in self._content_cache:
            print(f"Fetching content for {self.repo} : {self.path} at {commit.commit.author.date} - {commit.sha}")
            # We can retrieve the file content at a specific commit
            file_content = self.repo.get_contents(
                self.path,
                ref=commit.sha
            ).decoded_content.decode()
            self._content_cache[commit.sha] = file_content
        return self._content_cache[commit.sha]


def explode_runner_variants(runner_configs: Dict[str, Dict[str, any]]) -> Dict[str, Dict[str, any]]:
    runner_types_list = [i for i in runner_configs['runner_types'].items()]

    for runner, runner_config in runner_types_list:
        if 'variants' in runner_config:
            for variant, variant_config in runner_config['variants'].items():
                if runner.startswith('lf.'):
                    runner_without_lf = runner[3:]
                    variant_name = f"lf.{variant}.{runner_without_lf}"
                else:
                    variant_name = f"{variant}.{runner}"
                runner_configs['runner_types'][variant_name] = {
                    **runner_config,
                    **variant_config,
                }

    return runner_configs


def get_runner_config(retriever: LazyFileHistory, start_time: datetime.datetime) -> Dict[str, Dict[str, any]]:
    contents = retriever.get_version_after_timestamp(start_time)
    if contents:
        return explode_runner_variants(yaml.safe_load(contents))
    return {'runner_types': {}}


def create_breakdowns(runner_configs: Dict[str, Dict[str, any]], lf_runner_configs: Dict[str, Dict[str, any]]) -> Dict[str, Set[str]]:
    '''
    Create the breakdowns, that are groups of runners with some common characteristics that we might find relevant
    to view them in a group instead of individually.
    '''
    breakdowns = {
        'github': set(),            # provided by github
        'pet': set(),               # managed as pet instances
        'dynamic': set(),           # managed as auto-scaling instances
        'ephemeral': set(),         # auto-scaling instances that are ephemeral
        'nonephemeral': set(),      # auto-scaling instances that are not ephemeral
        'linux': set(),             # linux instances
        'linux-meta': set(),        # linux instances provided by meta
        'linux-lf': set(),          # linux instances provided by Linux Foundation
        'macos': set(),             # macos instances
        'macos-meta': set(),        # macos instances provided by meta
        'windows': set(),           # windows instances
        'windows-meta': set(),      # windows instances provided by meta
        'windows-lf': set(),        # windows instances provided by Linux Foundation
        'all': set(),               # all instances
        'lf': set(),                # instances managed by Linux Foundation
        'meta': set(),              # instances managed by meta
        'multi-tenant': set(),      # instances that are multi-tenant
        'other': set(),             # other instances
    }

    github_mac_runners = ('macos-12', 'macos-12-xl', 'macos-13-large', 'macos-13-xl', 'macos-13-xlarge', 'macos-14-arm64', 'macos-14-xlarge', )
    breakdowns['github'].update(github_mac_runners)
    breakdowns['macos'].update(github_mac_runners)

    meta_pet_mac_runners = ('macos-m1-12', 'macos-m1-13', 'macos-m1-14', 'macos-m1-stable', 'macos-m2-14', 'macos-m2-15', 'macos-m2-max', )
    breakdowns['meta'].update(meta_pet_mac_runners)
    breakdowns['macos'].update(meta_pet_mac_runners)
    breakdowns['pet'].update(meta_pet_mac_runners)

    meta_pet_nvidia = ('linux.aws.a100', 'linux.aws.h100', )
    breakdowns['meta'].update(meta_pet_nvidia)
    breakdowns['linux'].update(meta_pet_nvidia)
    breakdowns['linux-meta'].update(meta_pet_nvidia)
    breakdowns['pet'].update(meta_pet_nvidia)
    breakdowns['multi-tenant'].update(meta_pet_nvidia)

    all_runners_configs = runner_configs['runner_types'] | lf_runner_configs['runner_types']

    for runner, runner_config in all_runners_configs.items():
        breakdowns['dynamic'].add(runner)

        if 'is_ephemeral' in runner_config and runner_config['is_ephemeral']:
            breakdowns['ephemeral'].add(runner)
        else:
            breakdowns['nonephemeral'].add(runner)

        if runner_config['os'].lower() == 'linux':
            breakdowns['linux'].add(runner)
        elif runner_config['os'].lower() == 'windows':
            breakdowns['windows'].add(runner)

    for runner, runner_config in runner_configs['runner_types'].items():
        breakdowns['meta'].add(runner)

        if runner_config['os'].lower() == 'linux':
            breakdowns['linux-meta'].add(runner)
        elif runner_config['os'].lower() == 'windows':
            breakdowns['windows-meta'].add(runner)

    for runner, runner_config in lf_runner_configs['runner_types'].items():
        breakdowns['lf'].add(runner)

        if runner_config['os'].lower() == 'linux':
            breakdowns['linux-lf'].add(runner)
        elif runner_config['os'].lower() == 'windows':
            breakdowns['windows-lf'].add(runner)

    return breakdowns


def update_breakdowns(breakdowns: Dict[str, Set[str]], workers: Iterable[str]) -> None:
    for worker in workers:
        if not worker:
            continue
        breakdowns['all'].add(worker)
        if worker not in breakdowns['dynamic']:
            if 'ubuntu' in worker.lower():
                breakdowns['linux'].add(worker)
                breakdowns['github'].add(worker)
            else:
                breakdowns['other'].add(worker)


def get_clickhouse_client(host: str, port: int, username: str, password: str) -> clickhouse_connect.driver.client.Client:
    return clickhouse_connect.get_client(host=host, port=port, username=username, password=password)


def get_last_queue_time_historical(cc: clickhouse_connect.driver.client.Client) -> datetime.datetime:
    print("Getting last queue time from default.queue_times_historical....", flush=True, end="")
    res = cc.query(
        "SELECT MAX(time) as last_time_historical FROM default.queue_times_historical"
    )

    if (res.row_count != 1):
        raise Exception(f"Expected 1 row, got {res.row_count}")
    if (len(res.column_names) != 1):
        raise Exception(f"Expected 1 column, got {str(len(res.column_names))}")

    parsed_datetime = dateutil_parser.parse(str(res.result_rows[0][0])).replace(minute=0, second=0, microsecond=0, tzinfo=None)
    print(f"  done: {parsed_datetime}", flush=True)
    return parsed_datetime


def get_last_queue_times_24h_stats(cc: clickhouse_connect.driver.client.Client) -> datetime.datetime:
    print("Getting last queue time from misc.queue_times_24h_stats....", flush=True, end="")
    res = cc.query(
        "SELECT MAX(time) as last_time_historical FROM misc.queue_times_24h_stats"
    )

    if (res.row_count != 1):
        raise Exception(f"Expected 1 row, got {res.row_count}")
    if (len(res.column_names) != 1):
        raise Exception(f"Expected 1 column, got {str(len(res.column_names))}")

    parsed_datetime = dateutil_parser.parse(str(res.result_rows[0][0])).replace(minute=0, second=0, microsecond=0, tzinfo=None)
    print(f"  done: {parsed_datetime}", flush=True)
    return parsed_datetime


def get_queue_times_historical(cc, start_time: datetime.datetime, end_time: datetime.datetime) -> clickhouse_connect.driver.query.QueryResult:
    return cc.query("""
        SELECT
            machine_type,
            count,
            avg_queue_s,
            time
        FROM
            default.queue_times_historical
        WHERE
            time >= {start_time:DateTime}
            AND time < {end_time:DateTime}
        ORDER BY
            time ASC
    """, parameters={
        'start_time': start_time,
        'end_time': end_time,
    })


def get_jobs_interval(cc, start_time: datetime.datetime, end_time: datetime.datetime) -> Dict[str, int]:
    res = cc.query("""
        SELECT
            count(workflow.id) as count,
            length(job.labels) > 1 ? arrayElement(job.labels, 2) : arrayElement(job.labels, 1) AS machine_type
        FROM
            default.workflow_job AS job
            INNER JOIN default.workflow_run AS workflow ON workflow.id = job.run_id
        WHERE
            job.dynamoKey LIKE 'pytorch/pytorch%'
            AND job.created_at >= {start_time:DateTime}
            AND job.created_at < {end_time:DateTime}
            AND length(job.labels) > 0
            AND length(job.steps) != 0
            AND workflow.status = 'completed'
        GROUP BY
            machine_type
    """, parameters={
        'start_time': start_time,
        'end_time': end_time,
    })
    return {r[1]: r[0] for r in res.result_rows}


def get_opts() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument('--clickhouse-host', default=os.environ.get('CLICKHOUSE_HOST', ''))
    parser.add_argument('--clickhouse-port', type=int, default=int(os.environ.get('CLICKHOUSE_PORT', '8443')))
    parser.add_argument('--clickhouse-username', default=os.environ.get('CLICKHOUSE_USERNAME', ''))
    parser.add_argument('--clickhouse-password', default=os.environ.get('CLICKHOUSE_PASSWORD', ''))
    parser.add_argument('--github-access-token', default=os.environ.get('GITHUB_TOKEN', ''))
    parser.add_argument('--no-persistence', action='store_true', default=False)
    parser.add_argument('--max-hours', type=int, default=None)
    parser.add_argument('--rebuild-table', action='store_true', default=False)
    parser.add_argument('--worker-pool-size', type=int, default=1)
    return parser.parse_args()


def build_queue_history(queue_historical: clickhouse_connect.driver.query.QueryResult) -> Dict[str, List[float]]:
    queue_histories: Dict[str, List[float]] = {}
    queue_last_states = {}

    for row in queue_historical.result_rows:
        machine_type = row[0]
        count = row[1]
        avg_queue_s = row[2]
        time = dateutil_parser.parse(str(row[3])).replace(second=0, microsecond=0).replace(tzinfo=None)

        if machine_type in queue_last_states:
            old_avg_queue_s = float(queue_last_states[machine_type]['avg_queue_s'])
            old_count = int(queue_last_states[machine_type]['count'])
            sec_diff = (time - queue_last_states[machine_type]['time']).total_seconds()
            queue_groth_sec = avg_queue_s - old_avg_queue_s - sec_diff

            # skips if the queue is growing and no requests are being consumed
            if count < old_count or queue_groth_sec > 60 or queue_groth_sec < -60:
                if machine_type not in queue_histories:
                    queue_histories[machine_type] = []

                count_diff = old_count - count
                if count_diff > 0:
                    avg_consume_rate = old_avg_queue_s / float(old_count)
                elif count_diff < 0:
                    count_diff = abs(count_diff)
                    avg_consume_rate = old_avg_queue_s / count_diff

                for i in range(int(count_diff)):
                    queue_histories[machine_type].append(old_avg_queue_s - (avg_consume_rate * i))

        queue_last_states[machine_type] = {
            'count': count,
            'avg_queue_s': avg_queue_s,
            'time': time,
        }

    for machine_type in queue_last_states:
        if machine_type not in queue_histories:
            queue_histories[machine_type] = []

        old_avg_queue_s = float(queue_last_states[machine_type]['avg_queue_s'])
        old_count = int(queue_last_states[machine_type]['count'])
        avg_consume_rate = old_avg_queue_s / float(old_count)

        for i in range(old_count):
            queue_histories[machine_type].append(old_avg_queue_s - (avg_consume_rate * i))

    for machine_type in queue_histories:
        queue_histories[machine_type].sort(reverse=True)

    return queue_histories


def get_pct(queue_history, total_size, pct):
    pos = int(total_size * pct)
    if pos >= len(queue_history):
        return 0
    return queue_history[pos]


def get_max_list(lst):
    if len(lst) == 0:
        return 0
    return lst[0]


def gen_statistics(queue_histories: Dict[str, List[float]], total_jobs: Dict[str, int], breakdowns: Dict[str, Set[str]]) -> Dict[str, Dict[str, float]]:
    statistics = {}
    stat_counts = {b: 0 for b in breakdowns.keys()}
    stat_holders = {b: [] for b in breakdowns.keys()}

    runners = set.union(set(queue_histories.keys()), set(total_jobs.keys()))
    for runner in runners:
        count = total_jobs.get(runner, len(queue_histories.get(runner, [])))

        for b in breakdowns:
            if runner in breakdowns[b]:
                stat_counts[b] += count
                stat_holders[b] += queue_histories.get(runner, [])

        if runner not in queue_histories or len(queue_histories[runner]) == 0:
            statistics[runner] = {
                'avg': 0,
                'p25': 0,
                'p50': 0,
                'p80': 0,
                'p90': 0,
                'p95': 0,
                'p99': 0,
                'p999': 0,
                'max': 0,
            }
        else:
            sum_queue = sum(queue_histories[runner])
            statistics[runner] = {
                'avg': sum_queue / count,
                'p25': get_pct(queue_histories[runner], count, 0.75),
                'p50': get_pct(queue_histories[runner], count, 0.5),
                'p80': get_pct(queue_histories[runner], count, 0.2),
                'p90': get_pct(queue_histories[runner], count, 0.1),
                'p95': get_pct(queue_histories[runner], count, 0.05),
                'p99': get_pct(queue_histories[runner], count, 0.01),
                'p999': get_pct(queue_histories[runner], count, 0.001),
                'max': get_max_list(queue_histories[runner]),
            }

    for stat in stat_counts:
        if stat_counts[stat] == 0:
            statistics[stat] = {
                'avg': 0,
                'p50': 0,
                'p80': 0,
                'p90': 0,
                'p95': 0,
                'p99': 0,
                'max': 0,
            }
        else:
            stat_holders[stat].sort(reverse=True)
            sum_queue = sum(stat_holders[stat])
            statistics[stat] = {
                'avg': sum_queue / stat_counts[stat],
                'p50': get_pct(stat_holders[stat], count, 0.5),
                'p80': get_pct(stat_holders[stat], count, 0.2),
                'p90': get_pct(stat_holders[stat], count, 0.1),
                'p95': get_pct(stat_holders[stat], count, 0.05),
                'p99': get_pct(stat_holders[stat], count, 0.01),
                'max': get_max_list(stat_holders[stat]),
            }

    return statistics


def persist_statistics(cc: clickhouse_connect.driver.client.Client, statistics: Iterable[Dict[str, float]], last_time_stats: datetime.datetime) -> None:
    data = [
        [
            last_time_stats,
            machine_type,
            v['max'],
            v['p99'],
            v['p95'],
            v['p90'],
            v['p80'],
            v['p50'],
            v['avg'],
        ]
        for machine_type, v in statistics.items()
    ]

    cc.insert(
        table='queue_times_24h_stats',
        data=data,
        column_names=[
            'time',
            'machine_type',
            'queue_s_max',
            'queue_s_p99',
            'queue_s_p95',
            'queue_s_p90',
            'queue_s_p80',
            'queue_s_p50',
            'queue_s_avg',
        ],
        database='misc',
    )


def process_hours(
        cc: clickhouse_connect.driver.client.Client, hours: int, last_time_stats: datetime.datetime,
        opts: argparse.Namespace
    ) -> None:

    hour_range_generator = range(1, hours + 1)

    test_infra_repo = Github(auth=Auth.Token(opts.github_access_token)).get_repo('pytorch/test-infra')
    pytorch_repo = Github(auth=Auth.Token(opts.github_access_token)).get_repo('pytorch/pytorch')

    meta_runner_config_retriever = LazyFileHistory(test_infra_repo, '.github/scale-config.yml')
    lf_runner_config_retriever = LazyFileHistory(test_infra_repo, '.github/lf-scale-config.yml')
    old_lf_lf_runner_config_retriever = LazyFileHistory(pytorch_repo, '.github/lf-scale-config.yml')

    if opts.worker_pool_size == 1:
        for hour in hour_range_generator:
            process_hour(cc, hour, last_time_stats, opts, False, meta_runner_config_retriever, lf_runner_config_retriever, old_lf_lf_runner_config_retriever)
    else:
        with ThreadPool(processes=opts.worker_pool_size) as pool:
            res = [
                pool.apply_async(
                    process_hour,
                    (None, h, last_time_stats, opts, True, meta_runner_config_retriever, lf_runner_config_retriever, old_lf_lf_runner_config_retriever)
                )
                for h in hour_range_generator
            ]
            for r in res:
                r.get()


def process_hour(
        cc: clickhouse_connect.driver.client.Client, hour: int, last_time_stats: datetime.datetime,
        opts: argparse.Namespace, multiprocessing: bool, meta_runner_config_retriever: LazyFileHistory,
        lf_runner_config_retriever: LazyFileHistory, old_lf_lf_runner_config_retriever: LazyFileHistory
    ) -> None:

    end_time = last_time_stats + datetime.timedelta(hours=hour)
    start_time = end_time - datetime.timedelta(hours=24)

    # In the past, for a brief period, the runner configuration was stored in the pytorch/pytorch repository.
    # This is a fallback to get the runner configuration from that repository when it is not found in the test-infra repository.
    lf_runner_config = get_runner_config(lf_runner_config_retriever, start_time)
    if not lf_runner_config or not lf_runner_config['runner_types']:
        lf_runner_config = get_runner_config(old_lf_lf_runner_config_retriever, start_time)

    breakdowns = create_breakdowns(
        get_runner_config(meta_runner_config_retriever, start_time),
        lf_runner_config
    )

    process_start_time = time.time()
    if not multiprocessing:
        print(f"Processing hour {hour} - {start_time} to {end_time}", end="", flush=True)

    if cc is None:
        tlocal = threading.local()
        if not hasattr(tlocal, 'cc') or tlocal.cc is None:
            tlocal.cc = get_clickhouse_client(
                opts.clickhouse_host, opts.clickhouse_port,
                opts.clickhouse_username, opts.clickhouse_password
            )
        cc = tlocal.cc

    res_queue_times_hist = get_queue_times_historical(cc, start_time, end_time)
    res_total_jobs = get_jobs_interval(cc, start_time, end_time)

    if not res_total_jobs:
        timediff = time.time() - process_start_time
        if multiprocessing:
            print(f"No jobs found for hour {hour} - {start_time} to {end_time} - {timediff:.2f}", flush=True)
        else:
            print("No jobs found! This is because some entries on workflow_job.created_at are with wrong date", flush=True)
        return

    update_breakdowns(
        breakdowns,
        set([w[0] for w in res_queue_times_hist.result_rows])
    )
    update_breakdowns(breakdowns, res_total_jobs.keys())

    if not multiprocessing:
        timediff = time.time() - process_start_time
        print(f" - {timediff:.2f}s", end="", flush=True)

    if len(res_queue_times_hist.result_rows) or len(res_total_jobs):
        queue_histories = build_queue_history(res_queue_times_hist)
        statistics = gen_statistics(queue_histories, res_total_jobs, breakdowns)
        if not opts.no_persistence:
            persist_statistics(cc, statistics, end_time)

    timediff = time.time() - process_start_time

    if multiprocessing:
        msg = f"Processed hour {hour} - {start_time} to {end_time} - {timediff:.2f}"
    else:
        msg = f" - {timediff:.2f}s"
    if opts.no_persistence:
        msg += f" - no persistence {len(statistics)}"
    print(msg, flush=True)


def delete_documents(cc: clickhouse_connect.driver.client.Client) -> None:
    print("Wiping misc.queue_times_24h_stats", flush=True)
    cc.command("TRUNCATE TABLE misc.queue_times_24h_stats")
    print("Finished wiping misc.queue_times_24h_stats", flush=True)


def main(*args, **kwargs) -> None:
    start_time = time.time()

    opts = get_opts()
    cc = get_clickhouse_client(
        opts.clickhouse_host, opts.clickhouse_port,
        opts.clickhouse_username, opts.clickhouse_password
    )

    if opts.rebuild_table:
        delete_documents(cc)
        last_time_stats = dateutil_parser.parse('2023-03-01T00:00:00.000000Z').replace(tzinfo=None)
        print(f"Assuming last_time_stats is {last_time_stats}", flush=True)
    else:
        last_time_stats = get_last_queue_times_24h_stats(cc)

    last_time_historical = get_last_queue_time_historical(cc)
    hours = int((last_time_historical - last_time_stats).total_seconds() / 3600)
    if opts.max_hours:
        hours = min(hours, opts.max_hours)
    if hours:
        process_start_time = time.time()
        process_hours(cc, hours, last_time_stats, opts)

        total_time = int(time.time() - start_time)
        process_time = int(time.time() - process_start_time)
        print(f"Processed {hours} hours. Total time: {total_time}s - Process time: {process_time}s", flush=True)

if __name__ == "__main__":
    main()

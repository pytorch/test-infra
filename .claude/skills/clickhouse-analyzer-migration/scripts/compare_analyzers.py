#!/usr/bin/env python3
"""Run saved HUD ClickHouse queries on the old and the new analyzer and compare results.

  python3 compare_analyzers.py QUERY [QUERY ...] [--test-index N] [--params '{"k": v}']
      [--live-window [HOURS]] [--repeat N] [--explain] [--a-sql F] [--b-sql F]

QUERY is a folder under torchci/clickhouse_queries (e.g. tts_avg, vllm/trunk_health), or a
.sql file (e.g. inline SQL copied out of a .ts file; give all values with --params).
Side A runs on hud_user's session default, the old analyzer (checked at start); side B
adds allow_experimental_analyzer = 1. A SETTINGS opt-in in the SQL is set to 0 for an
`old` side; a `default` side (--analyzers) runs the SQL as HUD would, untouched.
Params: params.json tests[N] over `defaults`, then --params (same JSON format, {"from_now":
days} included), typed by the SQL's {name: Type} placeholders. Missing values are an error,
never guessed. See the skill's SKILL.md for the workflow.

Credentials: CLICKHOUSE_HUD_USER_URL / _USERNAME / _PASSWORD from the environment, else
from torchci/.env.local. Never printed. HTTP like HUD; if TLS fails, try --cafile
/etc/ssl/cert.pem, --no-proxy, another Python (macOS system Python links LibreSSL), or
--client clickhouse-client (port 9440, --secure, password passed via the environment; it
reads --param_limit / --param_offset as its own settings, so those params are renamed).
"""

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import ssl
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path


FMT = "JSONCompactEachRowWithNamesAndTypes"
OPT_IN = re.compile(
    r"\b(allow_experimental_analyzer|enable_analyzer)(\s*=\s*)(1|true)\b", re.I
)
PLACEHOLDER = re.compile(r"\{\s*(\w+)\s*:\s*([^{}]+?)\s*\}")
NOW_FN = re.compile(r"\b(now|now64|today|current_timestamp|current_date)\s*\(", re.I)
RIGHT_FINAL = re.compile(r"\bJOIN\s+(\w+\s*\.\s*)?\w+(\s+(AS\s+)?\w+)?\s+FINAL\b", re.I)
START = re.compile(r"start|from|begin|since|after", re.I)
STOP = re.compile(r"stop|end|until|before|^to", re.I)
KEYS = [f"CLICKHOUSE_HUD_USER_{k}" for k in ("URL", "USERNAME", "PASSWORD")]


def find_queries_dir():
    for start in (Path.cwd(), Path(__file__).resolve().parent):
        for d in (start, *start.parents):
            if (d / "torchci" / "clickhouse_queries").is_dir():
                return d / "torchci" / "clickhouse_queries"
    sys.exit("cannot find torchci/clickhouse_queries: run inside a test-infra checkout")


def load_creds(qdir):
    env = {k: os.environ[k] for k in KEYS if os.environ.get(k)}
    dotenv = qdir.parent / ".env.local"
    if len(env) < 3 and dotenv.exists():
        for line in dotenv.read_text().splitlines():
            k, sep, v = line.strip().partition("=")
            if sep and k in KEYS and k not in env:
                env[k] = v.strip().strip("'\"")
    if len(env) < 3:
        sys.exit(f"missing credentials: set {', '.join(KEYS)}")
    return [env[k] for k in KEYS]


def base_type(t):
    while m := re.fullmatch(r"(?:Nullable|LowCardinality)\((.*)\)", t.strip()):
        t = m.group(1)
    return t.strip()


def fmt_dt(d, typ):
    if base_type(typ) in ("Date", "Date32"):
        return d.strftime("%Y-%m-%d")
    return d.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def to_param(v, typ, now, top=True):
    """A params.json value in ClickHouse's escaped text form, as @clickhouse/client sends."""
    if isinstance(v, dict) and "from_now" in v:
        return fmt_dt(now + dt.timedelta(days=v["from_now"]), typ)
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "\\N" if top else "NULL"
    if isinstance(v, list):
        return "[" + ",".join(to_param(x, typ, now, top=False) for x in v) + "]"
    if not isinstance(v, str):
        return str(v)
    if "Date" in typ and re.match(r"\d{4}-\d\d-\d\dT", v):
        v = v.replace("T", " ").rstrip("Z")
    for raw, escaped in (("\\", "\\\\"), ("\t", "\\t"), ("\n", "\\n"), ("\r", "\\r")):
        v = v.replace(raw, escaped)
    return v if top else "'" + v.replace("'", "\\'") + "'"


def resolve_params(pfile, sql, args, now, notes):
    """Raw values for every placeholder the SQL uses, typed by the SQL."""
    used = {}
    for name, typ in PLACEHOLDER.findall(sql):
        used.setdefault(name, typ)
    pj = json.loads(pfile.read_text()) if pfile and pfile.exists() else {}
    declared, tests = pj.get("params") or {}, pj.get("tests") or []
    if pfile and not tests:
        notes.append("params.json has no tests: add one that returns rows")
    for n, t in used.items() if pfile else ():
        if n not in declared:
            notes.append(f"{n} is not declared in params.json, so HUD never sends it")
        elif declared[n].replace(" ", "") != t.replace(" ", ""):
            notes.append(f"params.json says {n}: {declared[n]}, the SQL says {t}")
    if args.test_index and args.test_index >= len(tests):
        raise ValueError(f"no tests[{args.test_index}] in params.json")
    values = dict(pj.get("defaults") or {})
    values.update(tests[args.test_index] if tests else {})
    values.update(json.loads(args.params or "{}"))
    if missing := [n for n in used if n not in values]:
        raise ValueError(f"no value for {missing}: pass --params from the caller")
    vals = {n: to_param(values[n], t, now) for n, t in used.items()}
    if args.live_window is not None:  # same window length (or HOURS), ending now
        dts = [n for n, t in used.items() if base_type(t).startswith("DateTime")]
        starts = [n for n in dts if START.search(n)]
        stops = [n for n in dts if STOP.search(n) and not START.search(n)]
        if len(starts) != 1 or len(stops) != 1:
            raise ValueError(f"--live-window: no single start/stop param in {dts}")
        (start,), (stop,) = starts, stops
        length = dt.timedelta(hours=args.live_window)
        if not args.live_window:
            p = lambda s: dt.datetime.fromisoformat(s.replace(" ", "T"))  # noqa: E731
            length = p(vals[stop]) - p(vals[start])
        vals[start] = fmt_dt(now - length, used[start])
        vals[stop] = fmt_dt(now, used[stop])
    return vals


class Http:
    def __init__(self, url, user, password, args):
        u = urllib.parse.urlparse(url)
        self.url = f"{u.scheme or 'https'}://{u.hostname}:{u.port or 8443}/"
        ctx = ssl.create_default_context(cafile=args.cafile)
        handlers = [urllib.request.HTTPSHandler(context=ctx)]
        if args.no_proxy:
            handlers.append(urllib.request.ProxyHandler({}))
        self.opener = urllib.request.build_opener(*handlers)
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()

    def run(self, sql, params, settings, timeout, fmt=FMT):
        qs = {**settings, "wait_end_of_query": 1, "default_format": fmt}
        qs.update({f"param_{k}": v for k, v in params.items()})
        url = self.url + "?" + urllib.parse.urlencode(qs)
        req = urllib.request.Request(url, data=sql.encode(), method="POST")
        req.add_header("Authorization", self.auth)
        t0 = time.time()
        try:
            with self.opener.open(req, timeout=timeout) as r:
                body = r.read().decode()
                summary = json.loads(r.headers.get("X-ClickHouse-Summary") or "{}")
        except urllib.error.HTTPError as e:
            return None, e.read().decode(errors="replace"), time.time() - t0
        except urllib.error.URLError as e:
            sys.exit(f"connection failed: {e.reason} ({ssl.OPENSSL_VERSION}), see -h")
        secs = int(summary.get("elapsed_ns", 0)) / 1e9
        return body, None, secs or time.time() - t0


class Client:
    def __init__(self, url, user, password, args):
        self.host = urllib.parse.urlparse(url).hostname
        self.env = dict(os.environ, CLICKHOUSE_USER=user, CLICKHOUSE_PASSWORD=password)

    def run(self, sql, params, settings, timeout, fmt=FMT):
        params = dict(params)
        for k in ("limit", "offset"):  # clickhouse-client reads these as its settings
            if k in params:
                sql = re.sub(r"\{\s*%s\s*:" % k, "{p__%s:" % k, sql)
                params["p__" + k] = params.pop(k)
        cmd = ["clickhouse-client", "--host", self.host, "--secure", "--port", "9440"]
        cmd += ["--format", fmt, "--time"]
        cmd += [f"--{k}={v}" for k, v in settings.items()]
        cmd += [f"--param_{k}={v}" for k, v in params.items()]
        kw = {"capture_output": True, "text": True, "env": self.env, "timeout": timeout}
        t0 = time.time()
        try:
            p = subprocess.run(cmd, input=sql, **kw)
        except subprocess.TimeoutExpired:
            return None, "client timeout", time.time() - t0
        if p.returncode:
            return None, p.stderr, time.time() - t0
        tm = re.findall(r"^\s*(\d+\.\d+)\s*$", p.stderr, re.M)
        return p.stdout, None, float(tm[-1]) if tm else time.time() - t0


def short_error(text):
    text = re.sub(r"Received from \S+\. DB::Exception: ", "", text)
    m = re.search(r"Code: (\d+)\. DB::Exception: (.*?) \(([A-Z_]{3,})\)", text, re.S)
    if not m:
        return None, " ".join(text.split())[:300]
    message = " ".join(m.group(2).split())[:300]
    return m.group(3), f"{m.group(3)} ({m.group(1)}): {message}"


def norm(v, sig):
    """Round floats and sort arrays, to tell likely-benign differences apart."""
    if isinstance(v, float):
        return float(f"{v:.{sig}g}")
    if isinstance(v, list):
        return sorted((norm(x, sig) for x in v), key=lambda x: json.dumps(x))
    return v


def parse(body):
    lines = body.splitlines()
    if len(lines) < 2 or "DB::Exception" in lines[-1]:
        raise ValueError(f"unexpected output: {' '.join(body.split())[:200]}")
    names, types = json.loads(lines[0]), json.loads(lines[1])
    return {"names": names, "types": types, "rows": lines[2:]}


def same_rows(a, b):
    return a["names"] == b["names"] and Counter(a["rows"]) == Counter(b["rows"])


def diff_details(a, b, runs, sig):
    """For `differs`: normalised equality, self-stability and column sums that moved."""
    na, nb = (
        Counter(json.dumps([norm(c, sig) for c in json.loads(x)]) for x in r["rows"])
        for r in (a, b)
    )
    res = {
        "normalised_equal": a["names"] == b["names"] and na == nb,
        "only_in_A": sum((na - nb).values()),
        "only_in_B": sum((nb - na).values()),
        "stable": {
            k: all("error" not in r and same_rows(v[0], r) for r in v[1:])
            for k, v in runs.items()
        },
    }
    if a["names"] != b["names"]:
        return res
    sums = {}  # how much the numbers move, for the PR description
    for i, (name, typ) in enumerate(zip(a["names"], a["types"])):
        if re.match(r"(Nullable\()?(U?Int|Float|Decimal)", typ):
            ta, tb = (
                norm(float(sum(v for v in col if isinstance(v, (int, float)))), sig)
                for col in ([json.loads(x)[i] for x in r["rows"]] for r in (a, b))
            )
            if ta != tb:
                sums[name] = [ta, tb]
    return {**res, "column_sums": sums} if sums else res


def compare_query(name, conn, args, now):
    raw = name.endswith(".sql")  # a scratch file, e.g. inline SQL from a .ts file
    qpath, notes, sides = Path(name) if raw else args.queries_dir / name, [], {}
    orig = qpath.read_text() if raw else (qpath / "query.sql").read_text()
    for side, path, analyzer in zip("AB", (args.a_sql, args.b_sql), args.analyzers):
        sql = Path(path).read_text() if path else orig
        if analyzer == "old" and OPT_IN.search(sql):
            sql = OPT_IN.sub(r"\1\g<2>0", sql)
            notes.append(f"{side}: the SQL opts in via SETTINGS; set to 0 for this run")
        sides[side] = {"sql": re.sub(r"[\s;]+$", "", sql), "analyzer": analyzer}
    try:
        all_sql = sides["A"]["sql"] + sides["B"]["sql"]
        pfile = None if raw else qpath / "params.json"
        vals = resolve_params(pfile, all_sql, args, now, notes)
    except ValueError as e:
        return {"query": name, "verdict": "not_run", "error": str(e), "notes": notes}
    if RIGHT_FINAL.search(orig):
        live = (
            "live window used"
            if args.live_window is not None
            else "rerun with --live-window"
        )
        notes.append(f"JOIN <table> FINAL (matters in 2-table joins): {live}")
    if NOW_FN.search(orig):
        notes.append("SQL calls now()/today(): results can shift between runs")
    out = args.out / (f"file__{qpath.stem}" if raw else name.replace("/", "__"))
    out.mkdir(parents=True, exist_ok=True)
    base = {  # as torchci/lib/clickhouse.ts, minus the query cache
        "use_query_cache": 0,
        "max_execution_time": args.max_execution_time,
        "output_format_json_quote_64bit_integers": 0,
        "date_time_output_format": "iso",
    }
    runs = {"A": [], "B": []}

    def settings(side, extra):
        new = sides[side]["analyzer"] == "new"
        return {**extra, **({"allow_experimental_analyzer": 1} if new else {})}

    def run_side(side):
        sql, timeout = sides[side]["sql"], args.max_execution_time + 30
        body, err, secs = conn.run(sql, vals, settings(side, base), timeout)
        rec = {"secs": round(secs, 3)}
        if err is None:
            try:
                rec.update(parse(body))
            except ValueError as e:
                err = str(e)
        if err is not None:
            rec["error_name"], rec["error"] = short_error(err)
        (out / f"{side}.{len(runs[side]) + 1}.jsonl").write_text(err or body)
        runs[side].append(rec)

    for _ in range(args.repeat):
        run_side("A")
        run_side("B")
    a, b = runs["A"][0], runs["B"][0]
    res = {"query": name, "params": vals, "sides": dict(zip("AB", args.analyzers))}
    if "error" in a or "error" in b:
        if "error" in a:
            res["verdict"] = "fails_both" if "error" in b else "fixed_by_new"
        else:
            res["verdict"] = "breaks_on_new"
        res["errors"] = {k: r["error"] for k, r in (("A", a), ("B", b)) if "error" in r}
        if code := b.get("error_name") or a.get("error_name"):
            res["hint"] = f"look up {code} in references/patterns.md"
    else:
        res["rows"] = [len(a["rows"]), len(b["rows"])]
        res["names_equal"] = a["names"] == b["names"]
        res["types_equal"] = a["types"] == b["types"]
        res["row_order_equal"] = a["rows"] == b["rows"]
        res["hash"] = {
            k: hashlib.sha256("\n".join(sorted(r["rows"])).encode()).hexdigest()[:12]
            for k, r in (("A", a), ("B", b))
        }
        if same_rows(a, b):
            res["verdict"] = "identical" if a["rows"] else "identical_empty"
            if not res["row_order_equal"]:
                notes.append("same rows, different order: check the ORDER BY for ties")
        else:
            res["verdict"] = "differs"
            if args.repeat == 1:  # one more pair: does each side agree with itself?
                run_side("A")
                run_side("B")
            res.update(diff_details(a, b, runs, args.sig))
    res["secs"] = {k: [r["secs"] for r in v] for k, v in runs.items()}
    res.update(notes=notes, out=str(out))
    if args.explain:
        for side in sides:
            extra = {"use_query_condition_cache": 0, "use_skip_indexes_on_data_read": 0}
            sql = "EXPLAIN indexes = 1 " + sides[side]["sql"]
            body, err, _ = conn.run(sql, vals, settings(side, extra), 60, "TSVRaw")
            (out / f"{side}.explain.txt").write_text(err or body)
            # Only the new analyzer's plans name columns __table1.x / "column identifiers"
            new_plan = bool(
                err is None and re.search(r"__table\d|column identifiers", body)
            )
            res.setdefault("plan_analyzer", {})[side] = "new" if new_plan else "old"
    (out / "summary.json").write_text(json.dumps(res, indent=1))
    return res


def report(r):
    print(f"\n== {r['query']}: {r['verdict'].upper()}")
    if r.get("params"):
        print("   params: " + " ".join(f"{k}={v}" for k, v in r["params"].items()))
    if r.get("sides", {"A": "old"}) != {"A": "old", "B": "new"}:
        print(f"   sides: {r.get('sides')}")
    for k in ("error", "errors", "hint", "rows", "names_equal", "types_equal",
              "row_order_equal", "hash", "normalised_equal", "only_in_A", "only_in_B",
              "stable", "column_sums", "plan_analyzer", "secs", "out"):  # fmt: skip
        if k in r:
            print(f"   {k}: {r[k]}")
    for note in r.get("notes", []):
        print(f"   note: {note}")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    add = ap.add_argument
    add("queries", nargs="+", help="saved query names or .sql files")
    add("--params", help="JSON object of param values, in params.json format")
    add("--test-index", type=int, default=0, help="params.json tests entry to use")
    add("--live-window", type=float, nargs="?", const=0, metavar="HOURS",
        help="move the start/stop window to end now (same length, or HOURS)")  # fmt: skip
    add("--repeat", type=int, default=1, help="alternating A/B runs, for timing")
    add("--a-sql", help="SQL file for side A instead of query.sql")
    add("--b-sql", help="SQL file for side B instead of query.sql")
    add("--analyzers", default="old,new", help="sides A,B: old, new or default")
    add("--explain", action="store_true", help="write EXPLAIN indexes = 1 per side")
    add("--sig", type=int, default=9, help="significant digits when normalising")
    add("--max-execution-time", type=int, default=120)
    add("--out", type=Path, default=Path("/tmp/analyzer-compare"))
    add("--client", choices=("http", "clickhouse-client"), default="http")
    add("--cafile", help="CA bundle for HTTPS, e.g. /etc/ssl/cert.pem")
    add("--no-proxy", action="store_true", help="ignore HTTP(S)_PROXY")
    args = ap.parse_intermixed_args()
    args.analyzers = args.analyzers.split(",")
    if len(args.analyzers) != 2 or not set(args.analyzers) <= {"old", "new", "default"}:
        sys.exit("--analyzers takes two of old, new, default, e.g. old,new")
    if (args.a_sql or args.b_sql) and len(args.queries) > 1:
        sys.exit("--a-sql/--b-sql take a single query")
    args.queries_dir = find_queries_dir()
    creds = load_creds(args.queries_dir)
    conn = Http(*creds, args) if args.client == "http" else Client(*creds, args)
    probe = "SELECT getSetting('allow_experimental_analyzer')"
    body, err, _ = conn.run(probe, {}, {"use_query_cache": 0}, 30, "TSVRaw")
    if err:
        sys.exit(f"cannot run a query: {short_error(err)[1]}")
    if body.strip() not in ("0", "false"):
        print("WARNING: the session default is the NEW analyzer", file=sys.stderr)
    now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, microsecond=0)
    print(f"session analyzer={body.strip()} now={now}Z out={args.out}", file=sys.stderr)
    results = []
    for q in args.queries:
        found = (
            Path(q).is_file() if q.endswith(".sql") else (args.queries_dir / q).is_dir()
        )
        if found:
            results.append(compare_query(q, conn, args, now))
        else:
            results.append({"query": q, "verdict": "not_run", "error": "not found"})
        report(results[-1])
    print("\nquery | verdict | rows A/B | median secs A/B")
    for r in results:
        med = [round(statistics.median(v), 3) for v in r.get("secs", {}).values()]
        print(f"{r['query']} | {r['verdict']} | {r.get('rows', '-')} | {med or '-'}")
    sys.exit(0 if all(r["verdict"] == "identical" for r in results) else 1)


if __name__ == "__main__":
    main()

# greenlight — Listing open PRs by trusted authors across MANY repos, efficiently

Research for evolving `greenlight/src/greenlight/github_client.py` +
`plan.py` from a single-repo REST fetch to (A) a clean multi-repo query-per-repo
baseline and (B) a single-request-spanning-many-repos design at scale.

**Bottom line up front:**

- **Near-term (a handful of repos): keep the per-repo REST `get_pulls` + client-side
  set filter.** It is correct, truncation-safe, already implemented, and cheap
  (pytorch/pytorch ≈ 29 core calls). Just loop a *list* of repos and aggregate.
- **At scale (many repos, hundreds/thousands of authors): move to GraphQL
  *aliased per-repo `pullRequests(states:OPEN, first:100)`* batched N-repos-per-HTTP-request,
  with client-side author filtering.** This is the only option that is BOTH correct
  (no 1000-result truncation) AND cheapest as R and A grow. It needs **no new
  dependency** — PyGithub 2.9.1 already exposes GraphQL (`client.requester.graphql_query`).
- **Author filtering stays CLIENT-SIDE (a `set`) in every option.** Neither REST
  `list pulls` nor the GraphQL `pullRequests` connection supports a server-side author
  filter, and the search-based alternatives that do are crippled by the 1000-result
  cap + 256-char/5-operator query limits at hundreds of authors.
- **Never use the Search API (REST or GraphQL) to *enumerate* open PRs** — the
  1000-result hard cap silently truncates and its ordering is non-deterministic. pytorch/pytorch
  alone has ~2900 open PRs.

---

## 0. Current state (verified)

`greenlight/src/greenlight/github_client.py`:
- `build_client(token)` → `Github(auth=Auth.Token(token), per_page=100)`. **`per_page=100`
  is already set at the client level** (PyGithub applies it to every PaginatedList).
- `list_open_prs_by_authors(client, repo, authors)` → `client.get_repo(repo).get_pulls(state="open")`,
  filters each PR's `user.login.lower()` against `trusted = {a.lower() for a in authors}`,
  skips `user is None`, returns `list[OpenPR]` sorted by number.
- `OpenPR` dataclass already carries `repo` — it is multi-repo-ready.

`greenlight/src/greenlight/plan.py`:
- `TARGET_REPO = "pytorch/pytorch"` (single string), `TRUSTED_AUTHORS: set[str]` (7 logins today).
- `run(config, *, fetch=_default_fetch)` — the `fetch` seam is the clean swap point for
  a different backend; `run` just logs the returned `OpenPR`s.

Installed lib: **PyGithub 2.9.1** (`greenlight/.venv/.../site-packages/github/`,
`pyproject.toml` pins `pygithub>=2.6.1`).

---

## 1. Query-per-repo (REST `get_pulls`) at multi-repo scale

**Confirmed cost model.** `Repository.get_pulls(state, sort, direction, base, head)`
(`Repository.py:3426`) — **there is no `author` parameter**; REST `GET /repos/{o}/{r}/pulls`
cannot filter by author. So you fetch *all* open PRs and filter client-side. Cost for R repos:

> **Σ_r ceil(open_PRs_r / 100)** requests against the **core** bucket (5,000/hr for a user/PAT).

`per_page=100` is required to get 100/page (REST default is 30 → 3.3× more calls);
greenlight already sets it. PyGithub's `PaginatedList` is **lazy** (`PaginatedList.py`:
`__iter__` → `_couldGrow`/`_fetchNextPage`) — it fetches one page at a time as you
iterate, so a `break` stops paging. There is no useful server-side stop condition for
"authored by trusted set" (no author filter), so you must iterate the whole list; the
laziness only helps if you add an orthogonal early-exit (you don't have one here).

**Scaling story (core = 5,000 req/hr for a PAT):**

| Scenario (R repos)                                   | Core calls / sweep | 5-min cadence (12/hr) | Verdict |
|------------------------------------------------------|--------------------|-----------------------|---------|
| 1 × pytorch/pytorch (~2900 open)                     | ~29                | ~348/hr               | trivial |
| 50 repos (1 big + 49 @ ~200 open)                    | ~127               | ~1,524/hr             | fine    |
| 200 repos (1 big + 199 @ ~200 open)                  | ~427               | ~5,124/hr             | **just over** budget at 5-min |

So per-repo REST is comfortable to **~150 repos on a 5-min cadence** (or ~200 on a
~7-min cadence). Beyond that the hourly **core** budget is the wall, and you should
move to option (d), which cuts HTTP round-trips ~10× and costs almost nothing on the
GraphQL points budget.

> ⚠️ If greenlight ever runs under a **`GITHUB_TOKEN` in GitHub Actions** rather than a
> PAT, the REST core budget drops to **1,000 req/hr per repo** and GraphQL to **1,000
> points/hr per repo** — a very different regime. greenlight uses
> `PYTORCH_GREENLIGHT_GITHUB_TOKEN` (a PAT ⇒ 5,000/hr user budget); keep it that way.

**Best PyGithub iteration pattern:** keep it as-is (`for pr in repo.get_pulls(state="open")`)
but wrap the per-repo call so one repo's failure (404 rename, 403 perms) is logged and
skipped rather than aborting the whole sweep — see Gotchas / partial failure.

---

## 2. A single request spanning MANY repos — what's actually possible

### 2a. REST — no cross-repo list-pulls endpoint
`GET /repos/{owner}/{repo}/pulls` is **strictly per-repo**. There is no REST endpoint
that lists pull requests across repositories. The only cross-repo primitive in REST is
the **Search API**, which is a different beast (below). Confirmed: `rest/pulls/pulls.md`
and PyGithub `get_pulls` signature.

### 2b. Search API (REST *and* GraphQL) — cross-repo but hard-capped ⇒ unsafe for enumeration
`is:open is:pr org:<org>` (org-wide) or several `repo:a repo:b …` (OR'd) do span repos
in one query-set, **but**:

- **1,000-result hard cap.** GitHub REST search returns "**up to 1,000 results for each
  search**" (`rest/search/search.md:21`). The **GraphQL `search` connection shares the
  exact same 1,000 cap** — the `after` cursor tops out at `cursor:999`, and `hasNextPage`
  goes `false` at 1,000 (cross-checked: community discussion #64629, herve.bzh, GitHub
  docs — see Sources). Org-wide open PRs for the pytorch org are far over 1,000, so an
  org-wide search **silently truncates ⇒ correctness bug**. Even a *single-repo* search
  on pytorch/pytorch (~2900 open) truncates.
- **Rate:** REST search = **30 requests/min** (`rest/search/search.md:34`; code-search is
  9/min) — a small, separate bucket. GraphQL search is billed on the 5,000-points/hr
  budget instead (usually ~1 point/request), so GraphQL gives more search throughput.
- **Query-string limits** (`rest/search/search.md:71-72`): a query is rejected if it is
  **>256 characters** (excluding operators/qualifiers) or has **>5 `AND`/`OR`/`NOT`
  operators**. Practically, that caps a single query at roughly **~20-30 `author:` logins**
  and a handful of `repo:` qualifiers. Hundreds of authors ⇒ many query-batches.
- **Non-deterministic ordering** on the search connection — paginating a >1000 slice
  loses/duplicates rows (community #148671). Another reason not to slice around the cap.
- **Eventual consistency** — the search index lags live state by seconds-to-minutes;
  freshly opened PRs can be missing.
- **Server-side author filter?** Yes — `author:` qualifiers work — but they're OR'd and
  bounded by the 256-char/operator limits, so useful only for *small* author sets.

**Verdict:** Search is fine for *small result sets* (e.g. "open PRs by these ~20 authors
in this repo" where the answer is well under 1000) but must **never** be used to
*enumerate* all open PRs. Given the trusted set will grow to hundreds, and result-set
size is unpredictable, do not build the core path on search.

### 2c. GraphQL aliased per-repo `pullRequests` connections — the right cross-repo primitive
The `Repository.pullRequests(states: OPEN, first: 100, after: $cursor)` field is an
**ordinary connection, NOT the search connection — it has NO 1000-result cap** and is
fully paginable via cursors. You can batch **N repos in one HTTP request via aliases**:

```graphql
query ($first: Int!) {
  r0: repository(owner: "pytorch", name: "pytorch") {
    pullRequests(states: OPEN, first: $first, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      nodes { number title url author { login } }
      pageInfo { hasNextPage endCursor }
    }
  }
  r1: repository(owner: "pytorch", name: "vision") {
    pullRequests(states: OPEN, first: $first) {
      totalCount
      nodes { number title url author { login } }
      pageInfo { hasNextPage endCursor }
    }
  }
  # … rN
  rateLimit { cost remaining resetAt }
}
```

- **Point cost is tiny.** Formula (`graphql/overview/rate-limits-and-query-limits…md:93-144`):
  sum the requests needed to fulfill each *connection* (assume each hits its `first`
  limit), divide by 100, round, min 1. Each top-level aliased `pullRequests(first:100)` is
  **1 request**, so N aliases in one HTTP call ≈ `ceil(N/100)` points, **min 1**. Batching
  100 repos' first pages = **1 point**. The whole pytorch org's open-PR enumeration is a
  few points against the 5,000/hr budget — effectively free.
- **Real constraints are elsewhere:** the **10-second per-request timeout**, the
  **500,000-node** per-call limit (`…:168-174` — N×100 PR nodes + author nodes stays far
  under this), query-size, and **secondary** rate limits. ⇒ keep the alias batch modest
  (~**10-25 repos/request**), not 100.
- **Pagination across aliases** is the one wrinkle: each alias needs its **own** cursor,
  so you can't reuse a single `$cursor`. Clean pattern: first request batches N repos'
  first pages; for any alias with `pageInfo.hasNextPage`, issue **follow-up single-repo
  paginated queries** (exactly the pytorch `trymerge.py` cursor-follow-up pattern). Most
  repos have <100 open PRs (one page); only giants like pytorch/pytorch (~29 pages)
  generate follow-ups, so total requests ≈ `ceil(R/batch) + Σ extra pages of big repos`.
- **Server-side author filter?** No — `pullRequests` takes `states`, `baseRefName`,
  `headRefName`, `labels`, `orderBy` only, **not author**. ⇒ filter client-side against
  the trusted `set` (O(1) per PR, scales to thousands of authors for free).

### 2d. GraphQL org-wide `search(query:"org:X is:open is:pr", type: ISSUE)`
Same 1,000-cap + non-determinism + eventual-consistency as 2b. Rejected for enumeration
for the same reasons; only its billing (points vs 30/min) differs.

---

## 3. Cost comparison at scale

R = repos, A = trusted authors, P_r = open PRs in repo r, T_r = open PRs *by trusted
authors* in repo r (T_r ≪ P_r). Buckets: REST **core** 5,000/hr; REST **search** 30/min;
GraphQL **5,000 points/hr**.

| Option | Requests / points per full sweep | Truncation-safe? | Author filter | Scales with R? | Scales with A? |
|--------|----------------------------------|------------------|---------------|----------------|----------------|
| **(a) per-repo REST `get_pulls` + client set filter** | `Σ_r ceil(P_r/100)` **core** calls (R=200 ≈ 427) | ✅ yes | client-side set | OK to ~150 repos @5-min, then core-bound | ✅ free (set) |
| **(b) org-wide REST Search + client filter** | 1 query-set, **30/min** bucket | ❌ **truncates >1000** | server `author:` (≤~25) | ❌ correctness bug | ❌ 256-char/5-op limits |
| **(c) GraphQL org-wide `search`** | ~1 point/req, 5,000 pts/hr | ❌ **truncates >1000** | server `author:` (≤~25) | ❌ correctness bug | ❌ same limits |
| **(d) GraphQL aliased per-repo `pullRequests` + client filter** | `ceil(R/batch)` HTTP + big-repo follow-ups; **≈ few points** total | ✅ yes | client-side set | ✅✅ ~10× fewer HTTP calls than (a) | ✅ free (set) |

**Correct AND cheapest as R and A both grow: (d).** It removes the 1000-cap correctness
problem (unlike b/c), collapses R repos into `ceil(R/batch)` HTTP round-trips (unlike a's
one-repo-at-a-time), costs almost nothing on the points budget, and keeps author
filtering as an O(1) set check that is indifferent to A. (a) remains the right choice
while R is small because it's already built and dead simple.

---

## 4. Prior art / reusable clients in the codebase

- **PyGithub 2.9.1 has first-class GraphQL — use it, no new dependency.**
  - Public accessor: `Github.requester` property (`MainClass.py:308`).
  - `requester.graphql_query(query, variables) -> (headers, data)` (`Requester.py:703`);
    raises `GithubException` on error, `UnknownObjectException` on `NOT_FOUND`.
  - `PaginatedList` supports **GraphQL cursor pagination** natively (`PaginatedList.py:201-238,
    368-460`): pass `graphql_query` + `graphql_variables` + `item_list` path; it injects
    `first`/`after` (or `last`/`before`) and *requires* the query expose
    `pageInfo { startCursor endCursor hasNextPage hasPreviousPage }`, `totalCount`, and
    `nodes` at that path. This is a **single-connection** paginator — perfect for the
    per-repo follow-up pagination in (d), but it can't drive the *aliased multi-repo*
    batch (which needs distinct cursors per alias). For the batch, call
    `requester.graphql_query` directly and page the aliases yourself.
- **House GraphQL patterns (raw, for reference — greenlight can do better via PyGithub):**
  - `pytorch/.github/scripts/github_utils.py:136` — `gh_graphql(query, **kwargs)`: raw
    `urllib` POST to `https://api.github.com/graphql`, raises on `errors`.
  - `pytorch/.github/scripts/trymerge.py` — the canonical **cursor-follow-up** pattern:
    a primary query with `pageInfo { endCursor hasNextPage }` on each connection, plus
    dedicated follow-up queries (`GH_GET_PR_NEXT_*`) that take `$cursor` to drain a single
    connection. Mirror this for repos with >100 open PRs.
  - `test-infra/tools/torchci/check_alerts.py:44` — raw `requests.post` GraphQL using the
    **`search(type: ISSUE, query: $query)`** connection (`issueCount`, label filters).
    Note it uses search for *small* label-scoped result sets — fine there, wrong for
    enumeration.
- No existing shared/reusable Python GraphQL *client* to import — each site hand-rolls
  raw GraphQL. greenlight should **not** copy the raw pattern; route GraphQL through the
  same PyGithub client it already uses (one auth path, one retry/rate-limit surface).

---

## 5. Concrete recommendation + sketch

### Near-term (few repos) — extend the REST path, don't rewrite
1. `plan.py`: `TARGET_REPO: str` → `TARGET_REPOS: tuple[str, ...]` (single source of the repo list).
2. `_default_fetch`: loop repos, call the existing `list_open_prs_by_authors` per repo,
   aggregate. Wrap each repo call to log-and-skip a per-repo failure (rename/perms)
   without aborting the sweep — but let a systemic failure (auth/network) propagate, so
   the phase `run()` still raises per greenlight's seam contract.
3. `OpenPR` already carries `repo`; no schema change. This scales fine to dozens of repos.

### At-scale (many repos, hundreds+ authors) — add a GraphQL fetch behind the same seam
Add `list_open_prs_by_authors_graphql(client, repos, authors, *, batch_size=20)` in
`github_client.py`, and swap `plan.run`'s `fetch` to it when the repo list is large.
Shape:

- Build an **aliased** query (`r0…rk`) for a batch of ≤`batch_size` repos, each
  `pullRequests(states: OPEN, first: 100)` with `nodes { number title url author { login } }`
  and `pageInfo { hasNextPage endCursor }` + a trailing `rateLimit { cost remaining resetAt }`.
- Call `client.requester.graphql_query(query, variables)`; inspect `data["errors"]` for
  **partial per-alias failures** (missing/renamed repo) and skip those, don't abort.
- For each alias, filter `nodes` by `author.login.lower() in trusted` (reuse the existing
  lowercased set), guarding `author is None` (ghost/deleted). Emit `OpenPR`.
- For any alias with `pageInfo.hasNextPage`, run **follow-up single-repo paginated
  queries** (trymerge-style, or PyGithub's GraphQL `PaginatedList`) until drained.
- Watch `rateLimit.remaining`; back off before exhaustion.

**Client choice:** stay on **PyGithub** (`client.requester.graphql_query`) — no raw
`requests`, no new dep, one auth/retry path. **Author filtering stays client-side** (set)
in both paths. **Migration** is a pure `fetch`-seam swap; `OpenPR`, `plan.run`, and the
CLI are untouched. Keep REST for small repo lists, GraphQL for large — or make the
threshold a config value.

### Gotchas (carry these into the design)
- **Truncation:** the search 1000-cap is why enumeration must use connections
  (`get_pulls` / `pullRequests`), never `search`.
- **Non-deterministic search ordering:** slicing a >1000 search loses/dupes rows — don't.
- **Eventual consistency:** search index lags; `get_pulls`/`pullRequests` read live state
  (fresher). Prefer them.
- **Point/rate exhaustion:** core 5,000/hr (get_pulls), search 30/min, GraphQL 5,000
  points/hr — **1,000/hr each if ever run under an Actions `GITHUB_TOKEN`**. Poll
  `rateLimit`/response headers.
- **Partial failure across repos:** one bad repo (rename/perms) must not sink the sweep;
  GraphQL returns partial `data` + an `errors` array per alias — inspect it. Still let
  systemic failures raise (greenlight seam contract).
- **Ghost/None authors:** PR `user`/`author` can be null (deleted account, some bots) —
  keep the existing None guard; GraphQL `author` is nullable too.
- **Case sensitivity & bots:** compare logins lowercased (already done). The allowlist
  set implicitly excludes bots unless listed.
- **`EXCESSIVE_PAGINATION`:** `first`/`last` must be 1-100 on every connection; >100 errors.

---

## Sources

Authoritative (GitHub docs mirror in `~/meta/actions-knowledge-base/repos/docs/content/`):
- `graphql/overview/rate-limits-and-query-limits-for-the-graphql-api.md` — points formula
  (5,000/hr user; 1,000/hr Actions token), node limit (first/last 1-100, 500k nodes),
  10s timeout. Canonical: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
- `rest/search/search.md` — "up to 1,000 results per search", 30 req/min, 256-char /
  5-operator limits. Canonical: https://docs.github.com/en/rest/search/search
- `rest/pulls/pulls.md` + PyGithub `Repository.get_pulls` — no author param.
- `search-github/searching-on-github/searching-issues-and-pull-requests.md` — `is:pr is:open`,
  `org:`, `repo:`, `author:` qualifiers.

GraphQL search 1000-cap cross-check (web):
- https://github.com/orgs/community/discussions/64629 — >1000 items from GitHub Search
- https://herve.bzh/github-graphql-api-search-for-more-than-1000-pull-requests/ — both REST
  and GraphQL cap at 1000; `cursor:999` is the last cursor
- https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api — cursor pagination
- https://github.com/orgs/community/discussions/148671 — non-deterministic search ordering / data loss

Installed source verified:
- PyGithub 2.9.1 — `greenlight/.venv/lib/python3.14/site-packages/github/`:
  `Requester.py:703` (`graphql_query`), `MainClass.py:308` (`requester` property),
  `PaginatedList.py:201-460` (GraphQL cursor pagination), `Repository.py:3426` (`get_pulls`).

House patterns:
- `~/meta/pytorch/.github/scripts/github_utils.py:136` (`gh_graphql`), `trymerge.py`
  (aliased connections + cursor follow-ups),
  `~/meta/test-infra/tools/torchci/check_alerts.py:44` (raw `search` GraphQL).

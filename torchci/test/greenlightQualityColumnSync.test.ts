// Pins the column names the GreenLight Quality page reads to the ones its queries emit.
//
// The page addresses query output by string — tile-config field names, DataGrid `field:`
// declarations, row property access — so a column renamed in SQL is `undefined` in
// TypeScript, not a type error. `yarn tsc` stays green while a tile silently renders "-"
// in place of its figure, which is how a rename of n_review_over_15m blanked this page's
// headline finding with every gate passing.
//
// A hand-written row interface would not close this: it would go stale in exactly the same
// way as the config string. The check has to derive from the SQL, so this parses the
// queries' outermost SELECT and asserts the page reads nothing they do not emit.
//
// What this file covers, and what it does not:
//
//   names, reads -> SQL    every column the page addresses is one a query emits
//   names, SQL -> decls    every field a registered row interface declares is one a
//                          query emits
//   nullability            a column with a NULL branch is declared nullable by the
//                          interface registered for its query
//   values                 the strings merged_version_approved can hold are the ones
//                          the page branches on
//   namespace              no column name is emitted by two queries
//   mapping                each coverage tile's split fields address their own column
//   parameters             every query declares, defaults and tests shadowMode, and
//                          filters on it once per grouping that attributes it
//   modes                  the states the union admits, the control offers and the SQL
//                          branches on are one set
//
// The decls and nullability rows cover the interfaces named in ROW_INTERFACES, and
// registration there is opt-in: an interface absent from it is checked by neither, and
// CoverageRow is absent deliberately — see that registry for why.
//
// Each catches a failure the others cannot see. A read of a dropped column renders "-";
// a declaration of a dropped column renders nothing at all, because a bare interface
// field is not a read — it matches no pattern here, and tsc is equally blind, so a field
// that lies about the wire shape survives both gates. Nullability is invisible again: the
// name matches and the type compiles while the wire stops guaranteeing a value. Values are
// invisible a third time, because keyof checks that a name exists, never that a comparison
// against it can succeed. The mapping is invisible a fourth time, because two fields typed
// against the same row are interchangeable to anything that only asks whether a name
// exists. And the reads check tests against the union of all four queries' columns, which
// is only safe while that namespace stays disjoint.
//
// The last two rows are not about columns. shadowMode travels as a declared query
// parameter, so nothing above can see it, and every link in its chain fails while still
// answering: a missing default is a NULL the server refuses, a half-updated filter falls
// open and reports the whole population under one mode's name, and a state added to one
// side alone both compiles and runs.
//
// The parsers, readers and floors live in ./greenlightQualityColumnSync.helpers; this file
// is the assertions. They were split when together they outgrew the 400-line ceiling.

import fs from "fs";
import { MERGED_VERSION_APPROVED } from "lib/greenlight/qualityFigures";
import path from "path";
import {
  catalogQueries,
  coverageTileFields,
  declaredFields,
  declaredNullable,
  emittedColumns,
  IS_SHADOW_COLUMN,
  isShadowGroupings,
  localImports,
  MIN_COLUMNS_PER_QUERY,
  MIN_FIELDS_PER_INTERFACE,
  MIN_QUERIES,
  MIN_READS_ACROSS_PAGE,
  modeList,
  multiIfResults,
  NOT_QUERY_READERS,
  nullableColumns,
  queryParamsJson,
  readColumns,
  ROOT,
  ROW_INTERFACES,
  SHADOW_MODE_PARAM,
  SHADOW_MODE_TYPE,
  shadowContract,
  shadowFilters,
  uiSources,
} from "./greenlightQualityColumnSync.helpers";

describe("GreenLight Quality column sync", () => {
  test("the page's query catalog is still detectable", () => {
    expect(catalogQueries().length).toBeGreaterThanOrEqual(MIN_QUERIES);
  });

  test("every query's outermost SELECT parses into a column list", () => {
    const thin = catalogQueries()
      .map((q) => `${q}: ${emittedColumns(q).size}`)
      .filter((s) => Number(s.split(": ")[1]) < MIN_COLUMNS_PER_QUERY);
    expect(thin).toEqual([]);
  });

  // The glob is by filename, so a helper named outside its pattern — lib/greenlight/
  // revertStats.ts, say — would read columns nothing here ever scans. Any module the
  // covered set pulls in from these two directories has to be covered too.
  test("the scanned set is closed under its own imports", () => {
    const covered = new Set(uiSources());
    const missing = Array.from(covered)
      .flatMap((f) => localImports(f).map((i) => [f, i] as const))
      .filter(
        ([, i]) => !covered.has(i) && !NOT_QUERY_READERS.has(path.basename(i))
      )
      .map(([f, i]) => `${path.basename(i)} <- imported by ${path.basename(f)}`)
      .sort();
    expect(Array.from(new Set(missing))).toEqual([]);
  });

  test("each registered row interface still parses into a field list", () => {
    const thin = Object.keys(ROW_INTERFACES)
      .map((i) => `${i}: ${declaredFields(i).length}`)
      .filter((s) => Number(s.split(": ")[1]) < MIN_FIELDS_PER_INTERFACE);
    expect(thin).toEqual([]);
  });

  // The inverse of the reads check, and invisible to every other gate: a field left behind
  // by a dropped column is a declaration, not a read, so no pattern here matches it and
  // tsc has nothing to object to. It then describes a wire shape that no longer exists.
  test("every field a registered row interface declares is emitted by its query", () => {
    const dangling = Object.entries(ROW_INTERFACES)
      .flatMap(([interfaceName, query]) => {
        const emitted = emittedColumns(query);
        return declaredFields(interfaceName)
          .filter((f) => !emitted.has(f))
          .map((f) => `${interfaceName}.${f} is not emitted by ${query}`);
      })
      .sort();
    expect(dangling).toEqual([]);
  });

  // The union of all four queries' columns is what the reads check tests against, and
  // `row` is `any`, so a tile reading another query's column passes every gate and
  // renders a permanent dash. Nothing can catch that while a name is unique to one
  // query — but a name emitted by two would let one query's value be read off the
  // other's row with nothing to notice. Keeping the namespace disjoint is what makes
  // the union safe to test against.
  test("no column name is emitted by more than one query", () => {
    const owners = new Map<string, string[]>();
    for (const query of catalogQueries()) {
      for (const column of emittedColumns(query)) {
        owners.set(column, [...(owners.get(column) ?? []), query]);
      }
    }
    const shared = Array.from(owners.entries())
      .filter(([, qs]) => qs.length > 1)
      .map(([column, qs]) => `${column} <- ${qs.sort().join(", ")}`)
      .sort();
    expect(shared).toEqual([]);
  });

  // Nullability is invisible to every other check here: the name matches, tsc is happy,
  // and the declaration quietly promises a value the wire no longer guarantees.
  test("a column with a NULL branch is declared nullable by its registered interface", () => {
    const wrong = Object.entries(ROW_INTERFACES)
      .flatMap(([interfaceName, query]) => {
        const declared = declaredNullable(interfaceName);
        return Array.from(nullableColumns(query))
          .filter((c) => declared.get(c) === false)
          .map((c) => `${interfaceName}.${c} is nullable in ${query}`);
      })
      .sort();
    expect(wrong).toEqual([]);
  });

  test("the page's column reads are still detectable", () => {
    expect(readColumns().size).toBeGreaterThanOrEqual(MIN_READS_ACROSS_PAGE);
  });

  // A level below the name checks. Rename one of these server-side and both consumers
  // degrade silently and differently: the table falls through APPROVAL_LABEL and prints
  // the raw string, while stalenessCounts scores zero confirmed and zero stale, so the
  // note announces that no verdict could be placed when every one of them could.
  test("merged_version_approved's values are the ones the query can emit", () => {
    const sql = fs.readFileSync(
      path.join(
        ROOT,
        "clickhouse_queries/greenlight_quality_reverts/query.sql"
      ),
      "utf8"
    );
    const fromSql = multiIfResults(sql, "merged_version_approved");
    expect(new Set(fromSql).size).toBeGreaterThan(1);
    expect(new Set(fromSql)).toEqual(
      new Set(Object.values(MERGED_VERSION_APPROVED))
    );
  });

  // A level below again, and the one indirection nothing else here constrains. Both fields
  // are typed `keyof CoverageRow`, so exchanging them is not a type error, and every other
  // check passes unchanged: each name is still a column some query emits, still unique to
  // one query, still declared. The page would paint NO_LAND green and LAND red with tsc,
  // lint and the rest of this suite silent. Which column belongs on which side cannot be
  // derived from either side of the mapping, so it is restated here.
  test("each coverage tile's split fields address their own column", () => {
    expect(coverageTileFields()).toEqual({
      prs_evaluated: { landField: "prs_land", noLandField: "prs_no_land" },
      verdicts_total: {
        landField: "land_verdicts",
        noLandField: "no_land_verdicts",
      },
    });
  });

  test("every column the page reads is emitted by some query", () => {
    const emitted = new Set(
      catalogQueries().flatMap((q) => Array.from(emittedColumns(q)))
    );
    const dangling = Array.from(readColumns().entries())
      .filter(([name]) => !emitted.has(name))
      .map(
        ([name, files]) => `${name} <- ${Array.from(files).sort().join(", ")}`
      )
      .sort();
    expect(dangling).toEqual([]);
  });

  // A parameter is not a column, so none of the checks above can see it. It travels as a
  // key in a JSON blob the API route hands to ClickHouse unvalidated, and every link in
  // that chain fails without saying so.
  test("every query declares shadowMode as a parameter of the type its SQL names", () => {
    const wrong = catalogQueries()
      .map((query) => ({
        query,
        declared: queryParamsJson(query).params[SHADOW_MODE_PARAM],
      }))
      .filter((q) => q.declared !== SHADOW_MODE_TYPE)
      .map((q) => `${q.query}: declared ${q.declared ?? "nowhere"}`)
      .sort();
    expect(wrong).toEqual([]);
  });

  // The one guard here standing between an edit and a 500. queryClickhouseSaved builds its
  // parameter map by iterating params.json's `params` and falling back to `defaults`, so a
  // parameter declared but left out of both reaches the client as undefined, is formatted
  // as `\N`, and is refused — ClickHouse takes no NULL for a typed parameter. Nothing else
  // looks: the SQL_PARAMS linter checks only that the `params` and `tests` keys exist.
  //
  // A default that merely disagrees is quieter and worse than an absent one. The page
  // renders one population while every caller that does not name a mode reads another, and
  // both answer.
  test("every query defaults shadowMode to the mode the page falls back to", () => {
    const { fallback } = shadowContract();
    const wrong = catalogQueries()
      .map((query) => ({
        query,
        applied: queryParamsJson(query).defaults[SHADOW_MODE_PARAM],
      }))
      .filter((q) => q.applied !== fallback)
      .map((q) => `${q.query}: defaults to ${q.applied ?? "nothing"}`)
      .sort();
    expect(wrong).toEqual([]);
  });

  // `tests` entries do not go through queryClickhouseSaved. clickhouse_query_perf.py hands
  // each one to ClickHouse as written, without applying `defaults`, so an entry omitting a
  // declared parameter fails there while the page is fine. A misspelt mode is the worse
  // half: it runs, falls open, and reports the whole population as though it were one
  // mode's.
  test("every params.json tests entry names a shadowMode the union admits", () => {
    const modes = new Set(shadowContract().modes);
    const wrong = catalogQueries()
      .flatMap((query) =>
        queryParamsJson(query).tests.map((entry, i) => ({
          where: `${query} tests[${i}]`,
          mode: entry[SHADOW_MODE_PARAM],
        }))
      )
      .filter((t) => !modes.has(t.mode))
      .map((t) => `${t.where}: ${t.mode ?? "absent"}`)
      .sort();
    expect(wrong).toEqual([]);
  });

  // The two halves of each filter are written separately and nothing in SQL ties them. Add
  // a mode to the selecting arms but not to the fall-open list and it matches both, so the
  // new mode quietly reads as the unfiltered population; add it to the list alone and the
  // mode returns nothing at all. Either way the query runs and answers.
  test("each shadow filter selects on exactly the modes it declines to fall open on", () => {
    const inconsistent = catalogQueries()
      .flatMap((query) =>
        shadowFilters(query).map((filter, i) => ({
          where: `${query} filter ${i + 1}`,
          selects: modeList(filter.selects.keys()),
          handled: modeList(filter.handled),
        }))
      )
      .filter((f) => f.selects !== f.handled)
      .map((f) => `${f.where}: selects on ${f.selects}, handles ${f.handled}`)
      .sort();
    expect(inconsistent).toEqual([]);
  });

  // What the union and the SQL each believe the states are, set against each other. A
  // fourth state added on one side only is invisible to everything else: tsc has no view
  // of the SQL, and the SQL falls open on any literal it does not recognise, so the new
  // mode compiles, runs, and silently reports every population as the unfiltered one.
  //
  // Falling open is also why the two sets are not equal. Exactly one mode carries no
  // selecting arm — the one every filter lets through — and it has to be the fallback, or
  // an un-parameterised call and an unrecognised value would land on different tiles.
  test("the modes the SQL selects on are the union's, less the one it falls open on", () => {
    const { modes, fallback } = shadowContract();
    const selective = modeList(modes.filter((m) => m !== fallback));
    const wrong = catalogQueries()
      .map((query) => ({
        query,
        selects: modeList(
          new Set(
            shadowFilters(query).flatMap((f) => Array.from(f.selects.keys()))
          )
        ),
      }))
      .filter((q) => q.selects !== selective)
      .map(
        (q) => `${q.query}: selects on ${q.selects}, union wants ${selective}`
      )
      .sort();
    expect(wrong).toEqual([]);
  });

  // Each option's value is typed ShadowMode, so a misspelt one is a compile error — but a
  // dropped one is not. The union stays three-valued and the SQL keeps branching on three
  // while the control offers two, and the missing mode becomes unreachable from the page.
  test("the control offers every mode the union admits", () => {
    const { modes, offered } = shadowContract();
    expect(modeList(offered)).toEqual(modeList(modes));
  });

  // Filtering the ledger row by row corrupts the units it reconstructs instead of removing
  // them — a cycle whose rows split across modes loses some to the filter and is rebuilt
  // from what is left, migrating between buckets rather than out of one. Every query
  // therefore groups first and filters the grouped flag, and a query that groups twice
  // must filter twice. Drop one and that half reports the whole population beside a half
  // that reports the selected one, with every column name still correct.
  test("every is_shadow grouping a query builds is consumed by a shadow filter", () => {
    const unfiltered = catalogQueries()
      .map((query) => ({
        query,
        grouped: isShadowGroupings(query),
        filtered: shadowFilters(query).filter((f) =>
          Array.from(f.selects.values()).includes(IS_SHADOW_COLUMN)
        ).length,
      }))
      .filter((q) => q.grouped !== q.filtered)
      .map((q) => `${q.query}: ${q.grouped} grouped, ${q.filtered} filtered`)
      .sort();
    expect(unfiltered).toEqual([]);
  });
});

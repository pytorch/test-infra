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
//   names, SQL -> decls    every field a row interface declares is one a query emits
//   nullability            a column with a NULL branch is declared nullable
//   values                 the strings merged_version_approved can hold are the ones
//                          the page branches on
//   namespace              no column name is emitted by two queries
//
// Each catches a failure the others cannot see. A read of a dropped column renders "-";
// a declaration of a dropped column renders nothing at all, because a bare interface
// field is not a read — it matches no pattern here, and tsc is equally blind, so a field
// that lies about the wire shape survives both gates. Nullability is invisible again: the
// name matches and the type compiles while the wire stops guaranteeing a value. Values are
// invisible a third time, because keyof checks that a name exists, never that a comparison
// against it can succeed. And the reads check tests against the union of all four queries'
// columns, which is only safe while that namespace stays disjoint.
//
// The parsers, readers and floors live in ./greenlightQualityColumnSync.helpers; this file
// is the assertions. They were split when together they outgrew the 400-line ceiling.

import fs from "fs";
import { MERGED_VERSION_APPROVED } from "lib/greenlight/qualityFigures";
import path from "path";
import {
  catalogQueries,
  declaredFields,
  declaredNullable,
  emittedColumns,
  localImports,
  MIN_COLUMNS_PER_QUERY,
  MIN_FIELDS_PER_INTERFACE,
  MIN_QUERIES,
  MIN_READS_ACROSS_PAGE,
  multiIfResults,
  NOT_QUERY_READERS,
  nullableColumns,
  readColumns,
  ROOT,
  ROW_INTERFACES,
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

  test("each row interface still parses into a field list", () => {
    const thin = Object.keys(ROW_INTERFACES)
      .map((i) => `${i}: ${declaredFields(i).length}`)
      .filter((s) => Number(s.split(": ")[1]) < MIN_FIELDS_PER_INTERFACE);
    expect(thin).toEqual([]);
  });

  // The inverse of the reads check, and invisible to every other gate: a field left behind
  // by a dropped column is a declaration, not a read, so no pattern here matches it and
  // tsc has nothing to object to. It then describes a wire shape that no longer exists.
  test("every field a row interface declares is emitted by its query", () => {
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
  test("a column with a NULL branch is declared nullable", () => {
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
});

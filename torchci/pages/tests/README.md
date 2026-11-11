# Tests page

`/tests/[organization]/[repo]` lists a repository's tests: the test hub's main
page, built on the [HUD API](../../app/api/README.md)'s `GET /api/tests`.
`/tests/[organization]/[repo]/test/[test_id]` is one test's own page, built on
`GET /api/tests/test/{test_id}`; its section is [below](#test-page).
`/tests/[organization]/[repo]/commit/[sha]` is one commit's page, built on
`GET /api/tests/commit/{sha}/summary` and `GET /api/tests/commit/{sha}`, with
GreenLight's verdict from `GET /api/tests/commit/{sha}/greenlight`; its
section is [below](#commit-page).
`/tests/[organization]/[repo]/pull/[number]` opens the commit page of a pull
request's newest head, found by `GET /api/tests/pull/{number}`; its section
is [below](#pull-request-page).
`/tests` redirects to `/tests/pytorch/pytorch` (a `redirects()` entry in
`next.config.js`), and the HUD navigation bar's Tests link, left of Help, goes
straight to `/tests/pytorch/pytorch` (`components/layout/NavBar.tsx`). The other
files in `pages/tests/` (`search.tsx`, `fileReport.tsx`, `testInfo.tsx`)
predate it, read `pages/api/flaky-tests/`, and follow none of the conventions
below.

This file is for the people who work on the page: the rules it keeps, where
its pieces live, and the decisions that are not obvious from the code. The
[OpenAPI document](https://hud.pytorch.org/api/openapi.json) is the reference
for the data it shows, and lists the pages under its `pages` tag with the
parameters they read from their URLs (the API README's
[HUD pages](../../app/api/README.md#hud-pages)); every API response carries
the page that shows it as `hud_url`.

## Best Practice

- The page never queries the database. Every byte it shows comes from an
  endpoint under `/api/tests`: no ClickHouse client, no SQL, no
  `queryClickhouse`, no `/api/clickhouse` named queries, no `pages/api/`
  endpoints. The API is the one contract: it validates parameters, documents
  its response, hands out cursors, and is where queries are measured and
  optimized. When the page needs data the API does not have, extend the API
  first, following its README, then the page.
- The pages are public, though the API is behind its GitHub gate: the routes
  the pages read let a page's own requests through without a credential
  (`admitHudPages` in `lib/api/auth.ts`, the API README's
  [Authentication](../../app/api/README.md#authentication)), so no page asks
  its reader to sign in. A page that starts reading another route opens that
  route to the pages in the same change.
- From `lib/api/` import types (`import type { ... }`) and, at run time, only
  the parameter definitions in `lib/api/tests/pages/parameters.ts`: the
  page's URL query defined as the API's own zod definitions, picked by name
  for the table page and added to for the test page, so the page reads its
  URL (`decodePageQuery`) and writes it (`pageUrlParams`) with exactly what
  the API validates with, and the OpenAPI document lists the page from the
  same objects. That module is zod and the registry alone; no handler, query
  or database client reaches the client bundle. The page depends on the API's
  response shape and parameter definitions, nothing deeper.
- Spell out no catalog value. The title's choices, their labels and their
  defaults come from `GET /api/tests/options` at run time
  (`useTestsOptions`), so a window, code source or language added to or
  removed from the API, a device, Python version or workflow newly recorded,
  or a default changed there, reaches the page with no page change.
  The page reads the options first, resolves the URL against them
  (`resolveTestsQuery`), and only then asks for the list, naming its
  `window`, `ran_on`, any `language`, any facet value and any name filter
  explicitly: the request says exactly what the sentence shows, even if a
  deploy lands between the two requests. The page knows the API's parameter
  _names_, the fifteen facets and the four name filters in
  `lib/tests/facets.ts`, each checked by the compiler against the page's
  parameter definitions, and never their catalog values; the labels of the
  environment cells come from the options too. The sort's default,
  `DEFAULT_TESTS_SORT`, is the API's own `DEFAULT_SORT`.
- Both themes, always. Colors come from the theme palette through
  `useTheme()`: text colors, the divider for hairlines, the greys of the
  pills. Nothing is painted a fixed color.
- Times are filled in on the client only, inside an effect. The server does
  not know the viewer's time zone and would print the wrong wall-clock time.
- Keep logic that needs no React in `lib/tests/` and unit test it in
  `test/tests/`; keep components thin.

## URL and state

- `sort` carries the API's own sort parameter, for example
  `?sort=-file,-suite,-case_name`, and is left off at the API's default, the
  Health header's chain worst first,
  `-status,-failure_rate,-failed_runs,-last_failed_at,-skip_rate,-mean_passed_duration_milliseconds`.
  Next.js encodes the commas as `%2C`; that is fine. A sort the
  API accepts but no header stands for, such as `-runs`, still works and shows
  no arrow; an invalid one shows the API's error text above an empty table.
- `window`, `ran_on` and `language` carry the title's choices in the API's
  spelling, left off at the defaults:
  `?window=1d&ran_on=main,pull_request&language=python&language=cpp`.
  `language` repeats once per checked language because the API reads a comma
  in it literally; nothing checked means all languages. A value the options
  do not offer is dropped, and a choice left empty by that falls back to the
  API's default, so a stale deep link still shows a page. `ran_on` never
  empties: the menu disables its last checked source. Any change of the
  query restarts paging. The sort is read and written on its own, so a
  header works before the options have arrived.
- The facet filters travel the same way, each under the API's own parameter
  name, repeated once per checked value and left off when nothing is
  checked: `?accelerator=cuda&accelerator_version=13.2&device_name=NVIDIA%20L4&python_version=3.11&test_config=default`.
  They are exact filters ANDed across facets and ORed within one, as the API
  defines them, so a pair chosen from a cell, CUDA with 13.2, is two
  parameters. A value the options do not offer is dropped like any other.
  The title never shows them: they belong to their columns, and their
  headers show them.
- `file`, `suite`, `case_name` and `declared_case_name` carry the API's exact
  filters on the test's name, repeated once per value and left off when none
  (`NAME_FILTERS` in `lib/tests/facets.ts`, `nameFilters` in the query):
  `?file=test%2Ftest_torch.py&case_name=test_add`. No menu sets them: a link
  does, the API's `hud_url` for a request that used them, say. The Name
  header shows each as a chip on the search field's rows beneath the text
  (`NameSearch`), the filter's name muted, then the value, then a button that
  takes that value out of the URL. A chip is as wide as its text, and the
  chips wrap onto as many rows as they need (`NAME_FILTER_ROW_HEIGHT` each),
  so nothing is cut off; only a value wider than the whole field ends in an
  ellipsis, whole in the chip's title. The field measures its own height with
  a `ResizeObserver` and reports how much taller than a key it is, and the
  header band grows by that (`columnHeaderHeightFor`), so the other headers'
  labels and keys stay centered. They go to the API as written, once each, and
  a view chip clears them as it clears the search. Without them a link for a
  request filtered by file would have shown the whole table; the API's
  `hud_url` is null rather than that for the list filters the page still
  lacks, the catalog ids and `env_vars`.
- `search` carries the Name header's search text as typed, under the API's
  own parameter, and is left off when empty. Typing does not write the URL at
  once: the text is held on the page (`typedSearch`) and the URL follows
  after a 750 ms pause in typing (`SEARCH_PAUSE_MS`), by `router.replace`,
  so a keystroke neither fetches a page nor adds a history entry. The pause
  is long because each search the URL takes is a full query that the
  database runs to the end whether or not the browser still wants it, and
  the half-second hesitations of a name typed from memory fired four queries
  per search at 250 ms. A file or suite clicked in a cell, or Enter in the
  field, writes the URL at once with `router.push`. Until the URL has caught
  up the listing is told the query is pending.
- Headers toggle between ascending and descending with no unsorted state. An
  unsorted state would fall back to the default and make ascending Health
  unreachable from the default. Name sorts by `file`, `suite`, `case_name`
  together; Mean Passed Duration sorts by
  `mean_passed_duration_milliseconds`, descending first, since a reader
  looking at durations wants the slowest first, and the API puts the tests
  without a pass, which have no mean, last in either direction. The mapping
  is `TESTS_TABLE_SORT_FIELDS`, and a new sortable column is one more entry
  there. Environment sorts by its eleven fields in one chain, accelerator and
  its version, device and its count, Python, OS and its version, architecture
  and capability, compiler and its version, so like sorts with like in the
  order the cell sets them; Test Config sorts by `test_config`; Owners by `owner`. A header click
  sorts the whole chain in one direction, so the URL carries all eleven
  fields; a URL ordering by some of them is a sort no header stands for.
- A view chip (`ViewChips`, with `lib/tests/views.ts`) writes its view's
  query: the view's `params`, served by `GET /api/tests/options`, are read
  exactly as a page URL is (`testsQueryFromUrl`, then `resolveTestsQuery`)
  and written back with `testsUrlParams`, so the URL carries ordinary
  parameters, never a view id, and a shared link means the same thing after
  a view's definition changes. Only Blocking viable/strict sets a window, 12
  hours; choosing any other view keeps the window the reader is in
  (`chooseView`). Every other parameter the view leaves out returns to its
  default, the search included, and text still being typed is dropped. A
  chip stays chosen while every parameter its view sets holds
  (`activeViewIds`): another filter, a search or a title choice the view
  leaves out refines it, while changing one the view sets, its sort or code
  source, leaves it. Of two views that hold, one that sets every parameter
  the other sets is the more specific and is shown alone, so Blocking
  viable/strict, which starts from the default sort on main, does not also
  light Least healthy. A click on a chosen chip returns only that view's
  parameters to their defaults and keeps the refinements (`withoutView`).
  The first view, Least healthy, is the list's defaults, so the page opens
  with it chosen. Options cached from before views existed offer none, and
  the row is empty.
- Paging follows the API's cursors one page at a time. The table keeps the
  cursor that fetched each visited page, so previous works; any change of the
  query restarts the walk. That state is derived during render, never synced by an
  effect, so a new query is never fetched with an old cursor. The page and
  cursor are not in the URL.
- The footer shows only the range on screen, "26–50", never a total. The API
  has no total, and an exact count exists only once the last page has been
  reached, so "of N" would appear on one page and not the others.

## Rendering decisions

- A row is one API entry: one test in one environment with one env var set.
  The same test appears once per configuration, thirteen times on average on
  2026-10-25, so the Environment and Config cells are what tell a test's rows
  apart; they are set to be scanned, not read in full.
- Environment (`Environment`, tokens from `lib/tests/environment.ts`) is two
  lines in the table's two voices: full strength, what torch was built for
  and the device it ran on, "CUDA 13.2 · NVIDIA H100 80GB HBM3 ×4"; muted and
  at caption size beneath, the Python and the platform, "Python 3.11 · Linux
  22.04 · x86_64 avx2 · GCC 11.4". The eleven catalog fields pair into these
  six tokens, a thing with its version or count (`TOKEN_PAIRS`, `pairText`):
  an empty half is left out, so a CPU build reads "CPU" and has no device
  token, and a device is counted only when there are several. Proper names
  take the options' labels (CUDA, Linux, GCC); versions, architectures,
  capabilities and device names are the catalog's own. The column is wide
  enough for the longest second line the catalog produces, the Windows
  build's "Python 3.10 · Windows 10.0.17763 · x86_64 avx512 · MSVC
  194234444", so no line is cut off; a longer one would end in an ellipsis.
  The tooltip lists all eleven fields as the catalog records them. A null
  environment reads "unknown environment".
- Test Config (`Config`) is the env var set's `TEST_CONFIG`, "default",
  "slow", "inductor", with a badge in the band's grey counting the set's
  other variables, "+2"; hovering the name or the badge lists every variable
  of the set as `NAME=value` in one tooltip, the config first and the rest
  by name; beneath, muted
  and at caption size, the workflows that called the configuration in the
  window, each by its file, "pull.yml · trunk.yml" (`workflowName` in
  `lib/workflowName.ts` strips the `.github/workflows/` every workflow
  shares; the options endpoint labels its values with the same function, and
  the cell never depends on the options for it), with the full path as the
  name's tooltip (`Token.tooltip`, which `FilterToken` shows and adds to its
  label). The line shows
  the names that fit a character budget (`fitTokens` with
  `WORKFLOW_LINE_BUDGET`, always at least one) and counts the rest, "+1",
  which hovering lists by path, so nothing is cut off (`CountedTokenLine`,
  which the Owners cell shares); on main a configuration has one workflow in
  93% of rows and two in the rest. The cell itself has no tooltip: what the
  column means is said once, in its header. The variable name is the one API
  value the page spells, because it is what the API's `test_config` parameter
  reads (`CONFIG_VARIABLE`). Its header's filter covers both the test config
  and the workflow (`workflow_path`, which the API filters but does not sort
  on; the header sorts by `test_config` alone).
- Owners (`Owners`) is the owner labels of the test's file as the API gives
  them, without the `module: ` prefix, "nn", each a filtering token on one
  line; a muted dash for a file without owners. More labels than the line
  holds are counted, "+1", and listed on hover (`CountedTokenLine` with
  `OWNER_LINE_BUDGET`; on 2026-10-25, 2,011 of 2,014 owned files had one
  label). Its header filters by `owner` and sorts by it: the API orders by
  the alphabetically first label and puts unowned tests last in either
  direction.
- Every header's label carries the column's description as a tooltip
  (`ColumnTitle`, `descriptionsFor` in `TestsTable`): the one place that explains a column, so no cell repeats it. A description is a plain sentence or two in the page owner's words (`descriptionsFor`), nothing more: Health's lists what each status means, one per line, and the two that depend on the window name the one in force, "within the last 12 hours", which the page passes as `windowLabel`. The label keeps the grid's own
  class, so it shares the header style and still sorts on click. The sorted
  column's header is marked as the active control it is, like a filled filter
  key: its label and its arrow take the accent color (as text on the band, a
  step darker in light mode and a step lighter in dark mode, `sortedHeaderText`,
  so it reads at 5.0:1 and 4.0:1 where the accent itself would be 4.0:1 and
  3.1:1) and an accent rule, 2px, runs along its bottom edge for the width of
  the column (an inset shadow, so the header keeps its height). The arrow
  alone was easy to miss.
- The Health, Environment, Test Config and Owners headers each hold their
  column's filter (`HeaderFilter`): a small key at the header's right edge, a rounded
  square on the page's background with an edge in the band's rule grey
  (`headerColors`, which the grid's styles share), so it stands off the band
  as a control in either theme. It holds an outlined funnel in the text
  color while nothing is chosen and is filled in the accent color, with a
  solid funnel, while something is, with what is chosen as its tooltip,
  "Filtering environment by CUDA
  13.2 · Python 3.11" (`facetsPhrase`: a pair chosen one value each as its
  token, any other facet as alternatives, a bare version with its title). It
  opens the column's facet menu (`FacetMenu`), under a first item, "Any
  environment", that stands for no choice and clears the column's facets.
  The Health and Owners menus list their one facet's values as checkboxes
  (`CheckMenuItem`, the row the title's multi-select menus render too).
  The Environment menu has eleven sections and the Test Config menu two,
  test config and workflow; a list of them all hid the later ones (the
  Workflow heading sat below 37 test configs), so each section is a folded
  row naming its facet and saying what is chosen, "Any", the one value, or
  "2 chosen" with the values on hover (`sectionSummary`), and a click on a
  row unfolds its checkboxes beneath it, folding the row that was open.
  Values that would run past the menu's bottom scroll their row to the top.
  Every row is folded again each time the menu opens. The menu stays open
  until the reader is done. The
  key stops its clicks and its keystrokes from reaching the header, which
  sorts on a click and on Enter (the grid sorts on any Enter that bubbles out
  of a header, so a key that let it through would sort the column every time
  it opened its menu); it is taken out of the header's flow (absolutely
  positioned, with the title container padded to make room), so the label and
  the sort arrow sit as they do in the other headers. The title's three pills
  are not involved: a column's filter is set, shown and cleared in that
  column's header.
- Every token in those three cells is a filter too (`FilterToken`): plain text
  that underlines when hovered, as a link does, and on click narrows each of
  its facets to that value and leaves the other facets alone, so clicking
  "CUDA 13.2" sets `accelerator` and `accelerator_version` and nothing else;
  the header's key then shows it. Tokens have no active state: a filtered
  value is the same in every row, and marking it would stripe the column.
- Where a row leads (`lib/tests/links.ts`): a row's cells follow one rule,
  text that describes the test narrows the list and the test's own figures
  open the test. The case name is a link to the test's page
  (`testPagePath`), bare, so its URL is short and the same from every row of
  the test, as the name is the way in on any list of things; the file and
  the suite beneath it search. The Health block, or the word of a healthy
  cell, and the Mean Passed Duration figure are evidence links
  (`testRunsHref`): a reader who clicks "Failing 92%" is asking to see the
  failures, so the link opens the test's page on the list's window and code
  sources, which the figure was counted over, with the row's configuration
  named (`environment=` and `env_vars=`, the row's catalog ids), which the
  grid marks among the others; the page's own defaults are left off, as
  the page leaves them off its own URL. Narrowing the list by status stays
  in the Health header's key, where the status filter already was. The
  links are real links (`TextLink`, and `CellBlock` given an `href`, both
  on `next/link` with prefetch off): the modifier keys and the middle
  button open a tab, the context menu copies the address, the status bar
  shows where they lead, Tab reaches them and Enter follows. The name and the duration figure are in HUD's link blue
  (`--link-color`, the color of the links in HUD's other tables, following
  the theme's mode), so a reader sees at a glance what can be followed; a
  first version kept them in the text color and the user asked for the blue
  (2026-10-29). The Health block keeps its hue's ink and the healthy word
  the muted text around it, so the Health column stays about status: HUD's
  global stylesheet paints a grid cell's links blue with a rule the table's
  own restates and outranks, `color: var(--cell-link-color, var(--link-color))`,
  and those two name their color in the variable (`TextLink`'s `tone`,
  `CellBlock`). The links announce themselves on hover with a
  full-strength underline in the text's own color, where the text that
  filters underlines in the disabled grey: the one hover says the table
  narrows, the other that the page changes. The whole row is not a link:
  the cells are copyable, and a row click would turn the first click of a
  double-click into a navigation; nor is there a hover-revealed arrow,
  since faint affordances failed in the headers. The Health tooltip ends
  with where a click leads.
- Every cell's text can be selected and copied, the text that acts included:
  a drag across a token, a file, a suite, a Health block or a link selects
  it like any other text, and the click that ends the drag does nothing
  (`endsTextSelection` in `lib/tests/selection.ts`, which `TextButton`,
  `TextLink` and `CellBlock` consult; a link prevents its default then), so
  the table does not reload, and the page does not change, under a
  selection the reader just made; a plain click, or Enter or Space on a
  control, still acts. The filtering controls are spans with the button
  role, not `<button>`s, whose text not every browser lets a reader select,
  and they override MUI ButtonBase's `user-select: none`; the links are
  marked not draggable, since dragging across a link drags the link in most
  browsers, and set `user-select: text`, since Chrome lets a selection begin
  inside a link only there (measured 2026-10-29: without it a drag across
  the name selected nothing and the mouse-up followed the link), and the
  case name's link is an inline block, for the Chrome selection reason the
  Name cell notes. Ctrl+C with text selected copies the
  selection; without one the grid copies the focused cell's value (the full
  node id for a Name cell).
- The Name header holds the column's filter the same way the others do: a
  search field (`NameSearch`) in the key style, a rounded square on the page's
  background with a ruled edge, with a magnifier, the text and a clear button
  once there is text, filling the header after the label and the sort arrow.
  The field is an item of the header's title row (the grid's content wrapper
  is `display: contents` in that header), ordered after the arrow, whose
  slot the row keeps whether or not the arrow shows, so the field stays put
  when the header is sorted or hovered; it is 6px from the arrow and from
  the header's edge, where the other headers' keys end. The edge and the
  magnifier take the accent color while the field has focus or text. Keys
  typed in it stay in it: the field stops its mouse and key events, since the
  header around it sorts on click and on Space and moves focus on the arrow
  keys. The field keeps its own text: the page echoes a keystroke back
  through the grid's columns a render late, and a controlled input would be
  reset to the old text in between, so the field remembers what it has sent,
  takes a value that comes back as the echo it is, and follows only a value
  set elsewhere, by a clicked token, the clear button or the URL. It keeps
  focus across the header's re-renders. Enter searches for the field's own
  text at once; Escape clears it. The API matches the text anywhere in the test's node id,
  `file::suite::case_name`, ignoring ASCII case, so what the Name cell shows
  is what a search finds. In the Name cell the file and the suite are
  searches too (`TextButton`, which `FilterToken` is built on): a click puts
  that text in the field and searches at once, as a token click sets a
  header's filter; a drag across them selects their text instead.
- Sorted by environment, a page runs through each environment's rows in turn;
  all but the first row of a run have their environment set one step softer
  (`repeated`), so the first row of each run stands out and the rest recede.
  Only the page on screen is compared, so the first row of a page is never
  softened.
- Color is not used for accelerators or vendors: the table carries emphasis
  by text color alone and keeps hue for status.
- The page computes the grid's row count itself (`pageCounts`): a controlled
  `rowCount={-1}` can never be corrected by the grid, which then says "more
  than" forever and keeps next enabled on empty pages.
- The page is one fixed-width column, centered (`PageColumn`, which the
  test page shares), so the table does not stretch with the window: as wide
  as the table with every column at its width (`TESTS_TABLE_WIDTH` in
  `lib/tests/layout.ts`, with the column widths, the Name column at its
  480px minimum), so at full width the table is whole and never scrolled
  sideways. The widths are
  budgeted to fit a 1920px display: 1905px after the scrollbar, less the
  body's 5px padding and the layout's 2px margin each side, the column's
  16px padding each side and the table's border, leaves 1855px for the
  columns, and they sum to 1840. The table is
  set like a typeset list, in the voice
  of the title: a 1px border in HUD's shared `--table-border-color` (set for
  both modes in `globals.css` and drawn by HUD's other tables; the grid's own
  border color darkens the divider and vanishes on the dark background)
  around the grid's rounded corners, compact rows, hairlines in the palette's divider color
  between rows, no vertical lines in the rows, and emphasis carried by text
  color. The header is a band in the same grey as the title's pills, clipped
  above by the box's rounded corners and square below so the first row's
  hairline meets it flush, with bold uppercase muted labels at the grid's own font
  size (0.875rem, as in HUD's other tables) and the
  grid's own short separator between columns, so the header and the title
  read as one system. Row and header heights are set in pixels, not through
  the grid's `density` setting, which multiplies whatever it is given by a
  hidden factor (`lib/tests/rows.ts`). A row is at least 44 (`minHeight` on
  its cells, which have 3px of padding above and below), which holds the
  duration cell's two tight lines with a little air and the Health cell's
  block, 37px then, exactly, and grows to hold a name that wraps onto more
  lines: `getRowHeight` returns `"auto"`, so the grid measures each row, and
  `rowHeight` (44) is what it assumes for a row it has not measured yet. The
  Last run cell is a flex cell for that reason too: a text cell would set
  its label at the top of a grown row. The header is 44
  (`columnHeaderHeight`) and holds its two-line label the same way, and grows
  by the rows of name-filter chips the Name header's search field holds, 22px
  each, while the URL carries exact name filters. The separator is a grey two
  steps off the band in each mode: the
  divider color is for lines on the page background and disappears on the
  band in dark mode. Column resizing is off, so the separator is only a
  divider. Every header and every cell is left-aligned, the figures too, so
  each column reads down one edge from its label; a right-aligned label would
  also jump, since the sort arrow takes no width until its header is hovered
  or sorted, so a label set against the right edge moves left to make room
  for it, while a left-aligned one stays put and the arrow appears after it,
  as in HUD's other tables. The Name cell (`TestName`) is two lines like
  the cells beside it: the case name full strength, since it is the test,
  over the file and suite leading up to it, muted and at caption size, with
  the `::` separators more muted still; a module-level function has no suite,
  and a name with only one part has no subtitle. Nothing in it is cut off:
  the column is 480px at least, about 60 characters of case name over 70 of
  file and suite, and a longer line wraps and its row grows with it. A name
  has no break opportunities of its own, so the cell gives it some (`<wbr>`):
  the subtitle may break after a `::` separator, never before one, and the
  case name after any `_` or `/` in it (`breakPieces`), so a wrapped name
  reads as its pieces, `test_compiled_dtensor_op_db_nn_functional_linear_cross_entropy_`
  over `cpu_float32`; only a piece longer than the column breaks anywhere
  (`overflow-wrap: anywhere`), as does a file or suite longer than the line,
  which is rare (114 of 673K files on 2026-10-26, no suite). The file and
  the suite get no `<wbr>` of their own because each must be one text node
  to be selectable: Chrome (156, measured 2026-10-26 with real mouse drags
  over the DevTools protocol) cannot start a drag selection inside an inline
  element with several child nodes when it sits at a half-pixel horizontal
  offset, which the centered page column has at every other window width;
  a single text node, a block, and offsets of .25 or .75 are fine. The parts
  that are searches run on over lines as text does (`TextButton`'s `wrap`):
  all of `TextButton` is spans with the button role rather than `<button>`s,
  which are one box however they are displayed, center what wraps inside
  them and push the separator onto a line of its own. The tooltip has the
  whole node id, to copy. Last run is set in tabular numerals. The
  band is painted on `.MuiDataGrid-columnHeaders` with the header cells and
  fillers made transparent, by direct selectors: MUI X v8 sets the header
  color through a CSS variable from its own style tag, which outranks the
  grid's `sx` class, while the row border color variable
  (`--DataGrid-rowBorderColor`) lives on the root and can be set from `sx`.
- The footer label goes through `localeText.paginationDisplayedRows`.
  `slotProps.pagination.labelDisplayedRows` type-checks and is ignored.
- `LastRun` decides by the viewer's local calendar day (`daySpan` in
  `TimeAgo.tsx`, which the "Updated" caption's phrase shares): "Today" for
  today, the weekday for yesterday through six days ago, month, day and year
  beyond. The label is computed once per timestamp, so a page left open past
  midnight keeps saying "Today" until the row re-mounts. The tooltip gives
  the elapsed time in the caption's words, "3 hours ago".
- The title is one sentence: "Tests in pytorch/pytorch that ran within the
  last 12 hours on main in all languages", and the three choices in it are
  the controls: flat grey pills (`InlinePill`) set in the
  heading's own font, with a chevron, opening a menu of one list
  (`InlineSelect`). One choice closes the menu; several keep it open. The
  title holds only what applies to the whole table, the window, the code
  sources and the languages; what narrows a column is in that column's
  header. The pills take their greys from the palette by mode. Until the
  options arrive, three short pill-shaped skeletons hold their places, and
  the table shows its loading state.
- The view chips sit on the caption's line, left of "Updated", 12px above
  the table, after a muted "Starter queries" label set like "Updated", with no
  colon, which also names the chips' group for assistive technology: pills in
  the grey of the title's, filled in the accent color for the view shown, as a
  header's filter key is while something is chosen, and in no status color,
  since hue is kept for status. Each chip's description is its tooltip,
  which is where a view's caveat goes. The line keeps a chip's height
  (`VIEW_CHIP_HEIGHT`) before the options arrive, so the table does not move
  when the chips appear.
- "Updated n mins ago" (`Updated`) is the table's caption: right-aligned
  just above the grid's top-right corner, in the secondary color, inside
  `TestsTable`, which has the listing's `refreshed_at`. It counts from the
  `refreshed_at` of the page's last fetch (`useTimeAgo`) and re-renders every
  ten seconds; its tooltip gives the exact time and the fifteen-minute
  refresh cadence. The page does not poll, so the count grows until a sort or
  page change fetches again. A skeleton as wide as the label holds its row
  before the first page arrives, so the table does not move when the label
  appears. The title above is the sentence alone.
- "Loaded in 5.2 s" (`LoadTime`) is the caption that closes the table:
  right-aligned just below the grid's bottom-right corner, under its footer,
  set like "Updated". It says how long the page shown took to arrive, from
  asking `GET /api/tests` for it to the decoded response, the waits and
  attempts of a request asked again included: `useTestsListing` times each
  request with `performance.now()` and keeps the time with the page in its
  cache, so a page returned to says what its request took, not that it came
  from the cache. The tooltip gives the exact figure and, from the page's
  `query_duration_ms`, what of it the API spent in the database. A skeleton
  as wide as the label holds the row while a page is on its way, so every
  sort, filter, search and page turn clears the label and fills it in again
  when the new page arrives, and nothing below the table moves; a page that
  failed leaves the row empty.
- The page owns the data: `useTestsOptions` in `lib/tests/` fetches the
  options once, and `useTestsListing` holds the paging state and the request
  and hands one page to the table, which shows its rows and its refresh
  time. The listing fetches with its own `AbortController`, not SWR: another
  page, another query or a keystroke in the search aborts the request on its
  way and drops its answer, so a reader never waits on a load they have moved
  on from. Between pages of one query the rows already shown stay under the
  grid's progress bar; a new query, or text still being typed, shows nothing
  but the grid's loading skeleton, since the rows no longer answer it. Pages
  fetched under one page load are kept by URL, so a page returned to, or a
  search retyped, shows at once. A list request that fails in a way that may
  pass on retry, the connection dropped or the server answering 5xx, is asked
  again after one second and once more after three (`RETRY_DELAYS_MS`), the
  grid keeping its loading state; a 4xx is the API's verdict on the request
  and shows at once (`mayPassOnRetry` in `lib/tests/request.ts`, the one
  retry rule every hook of the hub applies, beside `requestJson`, the one
  request the listing and the test page share, whose error carries the
  status, the API's text and its code). Once the retries are spent the API's
  error text shows
  above the table with a Retry button (`LoadError`) that asks again. A
  failure of the options request shows the same way and leaves the list
  unrequested; SWR asks again three times on its own, five seconds and more
  apart, and after that only the button does.
- Health (`Health`, with `lib/tests/health.ts`, `lib/tests/blockColors.ts`
  and the row geometry in `lib/tests/rows.ts`), right after the name, is in
  the two voices of the cells beside it: the status word, with the failure
  rate when there is one to tell, "Failing 92%", over the counts behind it,
  "36 of 39 runs · 124 skipped". The word is the API's `health.status`,
  labelled by the options (`statusLabel` raises the first letter of the
  running-text label), so the cell, the header's filter and the sort cannot
  disagree about what is failing. The API says failing when some run's last
  attempt failed (`failed_runs` exceeds `flaky_runs`), flaky when every
  failing run passed on retry, healthy when none failed, and skipped when
  there are no runs: the health table lists a configuration only once
  something ran or was skipped, so there is no "never ran" (live on
  2026-10-25 no window held a row with neither). The header's tooltip says
  what each word means, one per line (`ColumnTitle` keeps a description's
  line breaks). The rate is the API's `failure_rate`, runs with a failing
  attempt over runs, flaky ones included, so it agrees with the counts
  beneath it (`rateLabel`: whole percents from 10% up, one decimal below,
  "<0.1%" under that). Failing, flaky and skipped are blocks: a pale
  background of their hue holding the word, the rate and the counts in a
  dark shade of the same color, red, yellow and purple (`hueColors`: GitHub's label colors in both modes, since the theme has neither yellow nor purple and its warning orange would read as a fourth thing beside the red). The two-line cells, this one and Mean Passed Duration, share their lines (`CellLines` in `CellBlock.tsx`: a lead line over a smaller muted caption); this one sets them in a frame that is plain (`CellFrame`) or a block of a hue (`CellBlock`), the frame being the cell less a 3px margin on every side (the Health cell pads its sides by `CELL_VERTICAL_PADDING` instead of the grid's 10px, and the cell's content stretches to the row), so every block in a normal row is the same size and
  a block in a row that a wrapped name has grown is as tall as that row; the
  frame pads its text by the remaining 7px, so the text starts where the
  other cells' text does, and is rounded like the header's keys (6px).
  Healthy is plain muted text in the same
  frame, the unremarkable case the blocks stand out of. The block, or the
  healthy word, is the row's evidence link to the test's runs (above);
  filtering by status is the header's key, which offers all four. The
  tooltip lists every count and rate
  (`DetailList`, which the Environment tooltip shares) and ends with where
  a click leads. The header sorts
  worst first by what makes a test unhealthy: the status first, since a
  failure that survives its retries makes CI red while flakiness only costs
  retries; then the failure rate the cell shows; then how many runs failed;
  then the newest failure first, so among the single-run "Failing 100%"
  rows a failure an hour old outranks one from the morning; then the skip
  rate and the mean passed duration, which only the healthy rows reach,
  since every failing or flaky row has a failure time and those rarely tie:
  among healthy tests the mostly skipped come first, then the slowest.
  Ascending is healthiest first. The API puts skipped configurations, which
  have no status rank and no rates, last either way. This chain, worst
  first, is also the page's default sort, with the 12 hour window, so a
  fresh page opens on what is failing now: live on 2026-10-26 (main, 12
  hours) that was 20 failing and 32 flaky configurations before the first
  healthy row, where 7 days showed 137 failing of which 117 had not failed
  in the last 12 hours. Live on 2026-10-25
  (main, 7 days) a consistently flaky test reads "Flaky 100%" over "31 of 31
  runs", every first attempt failed and every retry passed, and a mostly
  skipped one "Failing 100%" over "1 of 1 run · 62 skipped", which is why
  the counts sit under the rate.
- Mean Passed Duration (`MeanPassedDuration`) is set in tabular numerals,
  left-aligned like every cell: the mean of the passed runs in the largest
  unit it fills
  (`durationLabel`: "625 ms" under a second, then "12.7 s", "32.3 min",
  "1.5 h", rounding up into the next unit rather than saying "60.0 s"), full
  strength, over the number of passed runs it averages in caption-size muted
  text, with the mean to the millisecond ("12,695 ms") as the tooltip. The figure is the row's evidence link to the test's runs (above), where the time bar times them; the dash is not. The two lines are the Health cell's (`CellLines` in `CellBlock.tsx`) without its frame, placed by the cell's own padding. Coloring slow means by tiers (yellow over 10 minutes, orange over 15, red over 20, in the Health cell's blocks) was tried on 2026-10-25 and taken out again as too much: the figures stay plain. The line heights are tightened to 1.25 so the two lines fit the row, and the
  column is a flex cell (`display: "flex"`): a text cell centers one line
  through its line height and would hang the stack from its baseline. Its
  label is too long for one line of a column as narrow as its figures allow,
  so that header alone is set on two lines inside the band: a line break in
  its `headerName`, kept by `white-space: pre-line` on its title. A label
  left to wrap on its own would fill the header's width and push the sort
  arrow to the far edge; broken by hand it is only as wide as its longer
  line, and the arrow follows it as in the other headers.
- Numbers are set in English like the page's sentences, digits grouped in
  threes with commas ("12,695") whatever the viewer's locale
  (`integerLabel`); only times follow the viewer's zone.
- A null `last_run_at` renders a muted dash; a null
  `mean_passed_duration_milliseconds` renders one over "0 passed runs", which
  says why there is no mean.

## Test page

`/tests/[organization]/[repo]/test/[test_id]` is one test's page, under its
repository's list, addressed by the API's stable test id, the `test.id` of
the list's entries. It keeps the rules above: nothing but `/api/tests`
endpoints, types only from `lib/api/`, the theme's colors, logic in
`lib/tests/` (`lib/tests/header.ts`, tested in `test/tests/testPage.test.tsx`).
It shows the test's header, where it lives, its name and a few facts, and
the grid of its runs by commit.

- The data is `GET /api/tests/test/{test_id}`, read by `useTestDetail` in
  `lib/tests/useTestDetail.ts` through the hooks' shared `useApiResource`
  (`lib/tests/useApiResource.ts`, which `useTestsOptions` and `useTestGrid`
  read through too): fetched once per page load through SWR, nothing until
  the router knows the id, and asked again on its own only after a failure
  that may pass on retry (`mayPassOnRetry`). An unknown test, the API's 404
  with the code `not_found`, is a state of the page, not an error, and is
  never asked again; the hook reports it as `notFound`. The page branches on
  the API's code, as the API asks, not on its text.
- The URL names a repository and the page shows only that repository's test:
  a test whose `repo` is another is treated as not found, so a pytorch test's
  id under a vision URL shows no pytorch test.
- The header (`TestHeader`) is three quiet lines over a hairline; hierarchy
  is carried by weight and tone, not size, and code is set in the system's
  monospace (`MONOSPACE_FONT_FAMILY`) at small sizes. A case name at a
  heading size reads as a row of underscores and gives the runner's
  parameters the same billing as the name. Neither the exact node id,
  `file::suite::case_name`, nor the test's id is shown: the breadcrumb and
  the headline carry the one, and the other means nothing to a reader.

  - A breadcrumb (MUI `Breadcrumbs`, monospace at HUD's `body2` size, the
    size of the table's captions and the view chips, secondary tone, `›`
    separators in the disabled tone): the repository, the file, the suite,
    each a link back to the list (`headerCrumbs`): the repository to its
    tests, the file to the list searched for its path, as a file clicked in
    the Name cell searches, and the suite to the list searched for
    `file::suite`, which the search, matching anywhere in the node id,
    narrows to that suite. A module-level function has no suite crumb.
  - The headline (`TestTitle`, the `h1`): the case name at HUD's `h5` size,
    a step under the list page's `h4`, in one line of two weights. The name
    as declared in the code is at weight 600 with the tracking drawn in; the
    parameters the runner appended follow at weight 400 in the secondary
    tone (`splitCaseName`: the declared name when it is how the case name
    starts, else the whole name, so an unparametrized test or one whose
    declared name is unknown reads whole). Selecting the line copies the
    whole case name. It wraps after a `_` or `/` (`Breakable`, shared with
    `TestName`), and each piece of the parameters is its own one-text-node
    span, for the Chrome selection reason the cell notes. Hovering the line
    tells the two names apart: a tooltip in the cells' style (`DetailList`,
    `caseNameDetails`) lists "Declared name" and "Case name" in full, the
    declared name reading "unknown" when the catalog has none, in a tooltip
    wide enough for a long name on a line or two.
  - A row of facts as pills (`FactPill`): `body2` text in the grey of the
    title's pills and the table's header band (`headerBandColor`), a view
    chip's height (`VIEW_CHIP_HEIGHT`), a muted word in title case for what
    each is and then the value a step heavier. They are read, not pressed,
    so they have no hover and no chevron. The language as the options label
    it (`labelOf`, a skeleton until they arrive, the raw value should they
    fail), which is its own word and has no label, marked with a dot in
    GitHub's color for the language (`LANGUAGE_COLORS`, linguist's Python
    blue and C++ pink, typed by the API's languages so a new one without a
    color does not compile; none for `unknown`). The mark is a dot, as
    GitHub sets it, not a tint of the pill: the hub keeps hue for status,
    and a tinted pill would read as one more status. Then "First Seen" with
    the date the catalog first saw the test in the viewer's zone and the
    time of day as its tooltip (`firstSeenLabel`, filled in on the client in
    an effect, as the Last run cell is); and "Owner" or "Owners" with the
    labels of its file. A value the catalog does not have is said rather
    than hidden, so the row always has its three pills: a file without
    owner labels reads "Owner Unknown" and a language the catalog could not
    tell reads "Language Unknown" (the options' own label for it, under a
    "Language" label the known languages do not need, with no dot), the
    word muted so a value that is there stands out (`UNKNOWN_LANGUAGE`, the
    one language value the page spells, and `UNKNOWN_VALUE`).
  - A hairline (`Divider`) closes the header.

  Until the test arrives a skeleton holds each line's place, so nothing
  moves when it comes; with no test to show the headline says "Test" and
  the rest is left out.

- Not found shows a warning beneath the title, "No test in pytorch/pytorch
  has the id 1.", with no Retry: the answer would be the same. Any other
  failure, a malformed id (the API's 400) or the server failing, shows the
  API's error text with a Retry button (`LoadError`), as the list page does;
  a failure of the options has its own Retry, which asks the options again.
- The page is set in the same column as the list (`PageColumn`), so the two
  pages share a measure and a reader moving between them sees the title stay
  put.

- Under the header, the grid of the test's runs (`RunGrid`; the decisions
  in `lib/tests/grid.ts`, the colors in `lib/tests/gridColors.ts`, the data
  in `lib/tests/useTestGrid.ts`, tested in `test/tests/grid.test.tsx`): the
  HUD grid turned on its side for one test, since a grid has no bucket to
  choose, aligns the workflows on the commits they share, and shows the
  lanes that only skip as faint rows. It is set as a table in the list
  table's frame: HUD's shared border around rounded corners, a header band
  in the same grey with the list's column titles (`HEADER_TITLE_STYLE` and
  `COLUMN_HEADER_HEIGHT` in `lib/tests/layout.ts`; Configuration, Outcomes,
  Runs: the cells are the test's runs and the commits are the axis, named
  in the footer; each title's tooltip is its column's description,
  `headerDescriptions`: a sentence, then a legend line per color, Outcomes
  naming the window and saying that expected failures, unexpected passes
  and unknowns are shown but not counted, Runs adding a line about the time
  bar while it is on), its short rule between columns, hairlines between
  rows, and a footer band in the header's grey. The band's right end holds
  the table's choices as keys in the headers' filter-key style
  (`headerKeyColors`, `headerKeySx` in `lib/tests/headerColors.ts`, shared
  with the list's keys):

  - `HeaderSelect` keys for the code sources and the window: the page's
    background with a ruled edge, the choice as text with a chevron,
    "main", "Last 3 days", a menu of one list, the accent edge while open,
    a tooltip naming what it chooses. The code sources key chooses one or
    both (`ranOnPhrase`, the list title's own phrase: "main and pull
    requests"), as the list's title combines them: an evidence link from
    the list keeps both, so the grid shows the runs the figure counted,
    and the API takes them comma-separated.
  - An "All outcomes" `HeaderSelect` choosing which outcomes' cells are
    shown, several at once, so a reader can show only the failures: its
    menu lists Failed, Flaky, Passed, Skipped and Other, each led by the
    swatch of its cells, under an item that chooses every one; the last
    outcome chosen cannot be unchosen, so the table always shows something;
    the key reads the one or two shown by name, "Failed, Flaky", or "3
    outcomes", and is filled in the accent while the grid is narrowed, as a
    header's filter key is while something is chosen. Narrowing is the
    page's own (`filterGroups`): the cells of the other outcomes are left
    out, the commits across stay so the axis does not move, each lane
    counts the cells shown and takes its status from them, so the failed
    swatch and the muting follow what is shown, a lane with no cell left
    and a workflow with no lane left drop out, and the order and the labels
    stay; the API is not asked again.
  - A `HeaderCheck` key, "Time bar" (the keys' height, background and ruled
    edge with a small checkbox), turns the time bar off and on, on by
    default, `time_bar=0` in the URL while off; the lanes keep their height
    either way, since the Outcomes column's time line needs the second
    line. With pull requests among the code sources shown the bar is off
    and the key unticked and disabled, its tooltip saying so
    (`timeBarAvailable`, `timeBarShown`):
    a stretch is a sustained change along one line of commits that build
    on one another, which pull requests are not, each branching from main
    at its own point and most running once. The reader's choice stays in
    the URL meanwhile, so main shows the bar again on return.
  - At the keys' left a `HeaderSearch` field (the keys' frame with a search
    glyph, the hash in the monospace, a clear button, Escape clearing too)
    finds a commit by its hash or the start of one, `commit=` in the URL:
    the column it names is banded and its pill pinned in the footer in
    the theme's blue, the accent the keys use, so a pin reads as the page's own mark (an orange pin had hidden the yellow flaky pills and a teal one dimmed the green passes, 2026-10-29); the column under the pointer is banded in orange instead, a transient mark that dims only what is under the pointer, apart from the hover's
    orange and the statuses' hues (`commitSearch`, `pinnedCommitColors`), and
    a hash no column starts with is told so on a small sheet under the key
    while the key is focused or hovered, the key's edge red, "No commit
    starting with 8f3a1 in the last 3 days of main. Widen the window, or
    check the hash." (`commitSearchMessage`, the key labels of the choices
    in force); a start several commits share asks for more of the hash in
    the muted text, and anything but hex digits is refused as no hash. The
    field keeps its own text: it goes out once typing has paused
    (`SEARCH_PAUSE_MS`), and the URL's echo of it is taken as the echo it
    is, as the list's `NameSearch` does, so typing never waits on the URL
    round trip and is never reset by it.

  The choices are read from the URL's `ran_on` and `window` as the API
  spells them and the page's own `outcomes` (comma-separated, in the menu's
  order), `time_bar` (`0` while off), `commit`, and `environment` with
  `env_vars`, the catalog ids of the configuration to mark (`LanePin`, both
  or neither), left off at the page's defaults (main, 3d, every outcome,
  the time bar on, no commit sought, no configuration marked) and resolved
  against the options. The seven are defined once, with their defaults and
  descriptions, as `TEST_PAGE_PARAMETER_DEFINITIONS` in
  `lib/api/tests/pages/parameters.ts`, which `resolveGridQuery` reads the
  URL through and `gridUrlParams` writes it through, and which the OpenAPI
  document lists as the `testPage` operation; the API's `hud_url` for a
  grid request is this page with `ran_on` and `window` and, for one
  configuration asked for by its ids, the mark. The marked configuration is the list's row a reader
  came from, named by its evidence links (`testRunsHref` in
  `lib/tests/links.ts`): every lane of it, one per workflow (`lanePinned`),
  is banded across in the pinned commit's blue (`pinnedCommitColors`,
  the band under the hover's orange) with a 6px strip of the solid blue at
  the table's left edge, and the first is scrolled into view under the
  header stuck to the viewport's top, once per grid and pin and only when
  it is not already in view, smoothly unless motion is reduced, so a
  reader who scrolls on is never pulled back. The strip is a control like
  the badge, click, Enter or Space, that unpins, taking the two parameters
  out of the URL; it is not a filter, since seeing the lane among its
  siblings is the point of the page, though the API could narrow to it. A
  pin that names no lane of the grid shown, the configuration having run
  outside the window or code sources, or its cells being among the
  outcomes left out, is said above the rows in the band and strip, "No
  runs for the configuration you came from on main in the last 3 days.",
  with an Unpin. The window holds jobs, not attempts: the
  API keeps the jobs whose first attempt started in it, with every attempt
  of theirs, as the health table assigns a run to its windows, so a run is
  never cut at the window's start. The grid is
  `GET /api/tests/test/{test_id}/runs?group_by=commit` for those choices,
  asked for as soon as they are known and shown once the test is known to
  be this repository's; a change of choice replaces the URL in place
  (`mergedUrlQuery`, shared with the list page), and the cache shows a grid
  returned to at once. The frame and its header stay while the body
  changes, so the keys never leave under the pointer: the body is the
  skeleton before any grid has arrived, the empty sentence ("No runs on
  main in the last 3 days.", or "No failed or flaky runs on main in the
  last 3 days." while the grid is narrowed), the load error with its Retry,
  or the rows. While new choices load, a progress bar in the theme's blue
  runs under the header band, as the list's grid shows one over its rows,
  and the grid shown last stays beneath it until the new one arrives
  (`keepPreviousData` in `useTestGrid`), since a skeleton's shimmer at every
  change of window is no obvious sign of loading. Under the frame's
  bottom-right corner, "Loaded in 1.2 s" (`LoadTime`, the list's own
  caption, the exact figures and the database's share in its tooltip) says
  how long the grid shown took to arrive, its skeleton holding the row
  while one loads.

  One column per commit the test ran on, newest left, so the latest runs
  stand beside the counts and come first in a reading from the left
  (`columnCommits`; the API lists commits oldest first), each column at
  least `MIN_CELL_WIDTH` (4px) wide: when the commits fit the room after
  the fixed columns they share it; when they do not, the step holds at a
  4px pill and a 1px gap and the plot grows past the room and scrolls
  sideways under the fixed label and Outcomes columns, the newest commits
  in view at first (`columnLayout`'s `plotWidth`; fitted to the room, a
  cell under 3px lost its width to its edge and the whole runs area was
  blank, as every pull request view was and the main view on a 1440px
  screen). The fixed columns are one SVG and the plot another, in a
  scroller whose own scrollbar is hidden, the footer strip's thin
  scrollbar standing for both and the two kept in step on scroll; only
  the columns in view are drawn (a pull request week is some 1,400
  columns), the day marks and the time bar in full, a wide stretch's label
  riding along inside the part of its block in view; a new code source or
  window starts at the newest commits, and a found commit is scrolled into
  the middle of the room. One row per
  workflow configuration, grouped under the workflow's file. Each workflow
  is a
  section: a row in the header band's grey with the file's name in the
  monospace at the `body2` size, so where one workflow ends and the next
  begins is seen as a change of color, the configurations beneath on the
  page background in the caption size. A lane's label is two lines, as the
  list page's Config and Environment cells set the same things
  (`laneLines`, on `environmentTokens` with the options' labels): the
  config, then what torch was built for and ran on, "default · CUDA 13.2 ·
  NVIDIA L4"; muted beneath, the Python and the platform, `Python 3.11 ·
Linux 22.04 · x86_64 avx2 · GCC 11.4`; a one-line label with a single
  distinguishing token had been thinner than the list's Environment column.
  The whole environment, field by field, is in the label's tooltip. Two
  lines make a lane 40px with or without a time bar; a lane without an
  environment keeps one line, 20px, or 26px when it carries a badge, so the
  badge has air (`foldedLaneHeight`, `GRID_SIZES.twoLineLaneHeight`,
  `badgedLaneHeight`). The variables set besides the config are counted in
  a badge at the label column's right edge on the label's last line, "+3
  vars" (`badgeLabel`, `badgeColors`: the header band's grey in a pill, as
  the list page's Config cell counts them; as words on the first line they
  had made the label column 500px wide at the runs' expense and named a
  variable without its value), that a click, or Enter or Space with the
  keys' focus ring on it, opens: the pill's lower half squares off into a
  panel of the same grey hanging from it, the label's width across, its
  top-right corner square where the tab meets it (`panelPath`), that lists
  the variables in full, `PYTORCH_TEST_WITH_SLOW=1`, one a line in the
  monospace between 6px of padding (`labelLayout`: baselines, badge top,
  panel top and height; `laneHeightFor`; `gridRows` with the expanded
  keys). The lane grows downward by the panel and 6px of air while the
  label, the badge, the pills, the time bar and the figures stay where they
  were, so the badge is still under the pointer for the click that folds it
  and nothing a reader is looking at moves; the expansion is the page's own
  state, not the URL's. The run pills keep their height in an expanded
  lane: their height says nothing, and growing them would make the one
  expanded lane's runs read as different from the rest. The hover card
  lists the variables one a line in the monospace, as the list page's
  tooltip does. Groups are worst first (`gridGroups`, the health view's
  statuses from the cells: failing with a failure that stood, flaky when
  every failure recovered, healthy, skipped; a cell folds a job and its
  re-run, GitHub's or a later run of the same workflow on the commit, into
  one sequence where the health table counts each job's run on its own, so
  a configuration whose job failed and whose re-run passed reads flaky here
  and failing in the list's Health column); within a workflow the lanes are
  in label order, the config first, then the environment, then the
  variables (`compareLanes`, numbers compared as numbers), so one config's
  environments sit together where worst first had scattered them. The label
  column is as wide as its longest label once the browser has set them
  (`getComputedTextLength`), estimated before, so no label is cut off or
  runs into the counts; the header's titles and rules follow the same
  measure (`gridColumns`).

  Beside each lane one Outcomes column: its passed, failed and skipped
  cells counted in three fixed slots (`gridColumns`), each count led by a
  swatch in the color of the cells it counts (`outcomeSwatchStatus`: the
  failed swatch yellow when every failure shown recovered) with the figure
  a short gap after it, a zero left blank, so the swatches and the figures
  align down the column and the swatches say what the colors mean; there
  is no legend, since the counts' swatches and the hover card, which names
  a cell's outcome beside its swatch, make one unnecessary. Under the
  counts, on the column's second line, the median window time: the median
  time of the lane's passing cells (`LaneTimes.typical`; the code keeps
  `typical` in its identifiers) with a bar after it that is its share of
  the slowest configuration's (`typicalBarColor`), which is how the
  configurations compare with each other; nothing when nothing passed. The
  figure is left-aligned under the first swatch and the bar a short gap
  after the widest figure in the grid (`estimatedTextWidth`), cut to the
  column's right inset should the figures ever run wide. It is a median
  because that is the statistic the time bar's blocks use, so a lane with
  one stretch shows the same figure in both places, and because a median
  shrugs off the odd slow cell. It is the grid's own figure, not the list's
  Mean Passed Duration, and the two differ: a lane is one calling workflow
  where a health entity spans every workflow the configuration ran in, a
  cell keeps a commit's shards and re-runs as jobs of their own and takes
  their mean, and the health view is refreshed on its own clock (one CUDA
  configuration read 1484 ms as a health entity across periodic.yml and
  trunk.yml where the grid's two lanes read 3029 ms and 1490 ms). The
  tooltip says what the figure is and what the bar compares; the rule
  behind the figure is in `laneTimes`' comment.

  A cell is every attempt of that configuration on that commit, a small
  pill 12px tall (`GRID_SIZES.cellHeight`; `cellRadius`: half its shorter
  side, so a cell taller than wide is a capsule and a thin one nearly
  round) colored by how it ended (`cellStatus`); a run whose first attempt
  ended differently from how the run ended is two capsules with 2px of the
  page between them, the first attempt's status above how the run ended,
  red over yellow for the usual flake (`attemptSplit`, `splitBoxes`,
  `cellParts`, `GRID_SIZES.splitGap`; one pill otherwise: a failure retried
  and failed again, a timeout whose rerun was skipped, since a skip never
  overrides an executed attempt, a run skipped twice). Two capsules rather
  than the attempts banded inside one pill, which were too hard to read at
  the 3 to 5px cells a week of main gives; the cells are 12px tall and the
  bare lane 20px (`laneHeight`) to give the capsules room, 5px each. The
  attempts read are the deciding jobs' alone: a cell's jobs of one name are
  a job and its re-run, one chain; jobs of different names are sibling
  shards, the worst of which decides the cell, and a sibling's run is no
  rerun of another's (`decisiveSequence`, `decisiveAttempts`; two
  inductor_core shards' runs on one commit, a timeout whose rerun skipped
  beside a shard that skipped on its own, had read as one chain, timed out
  then skipped twice). A cell is at least `MIN_CELL_WIDTH` (4px) wide and
  at most 14 (`columnLayout`), the rest of its step a gap of at least a
  pixel; commits that would need a narrower cell scroll the plot instead
  (above).
  The pill is a small pill of its status's hue from the hub's one palette
  (`PILL_COLORS` in `lib/tests/blockColors.ts`, so the grid's cells and the
  list page's Health blocks move together): every hue holds, in each mode,
  the big pill, the Health block (a pale background and its text's deep
  shade), and the small pill, a cell (a tint for its fill, a mid shade for
  its edge, a deeper shade for its fill under the pointer), and the grid
  reads the small one (`gridColors`: failed red, flaky yellow, passed
  green, skipped purple; an expected failure or an unknown is unfilled with
  an edge in the disabled tone). The small fills are the blocks'
  backgrounds, the pale yellow of a Flaky block, the pale purple of a
  Skipped block, except where a few pixels need more color: the failed cell
  is two steps stronger in fill and edge, since at a cell's size the
  block's pale red was mistaken for the skipped purple, and a pass, which
  has no block on the list page, is a pale green, rgb(213, 245, 222), a
  wash of the same strength as the other fills in dark mode (a grey read as
  a run that did not happen; stronger greens overwhelmed the failures).
  Every cell has a one-pixel edge drawn inside its box (`edgedBox`, so it
  does not eat the gap to the next cell), since the pale yellow alone was
  hard to see, in the hue's mid shade (halfway between GitHub's first and
  second steps in light mode, a step short of its saturated mid step in
  dark); the Outcomes swatches and the card's swatch carry the same edge. A
  lane that only ever skipped is muted, so that skipping is seen rather
  than read, and its pills are the height of every other, since a pill's
  height says nothing.

  Under a configuration's pills runs its time bar, which says how long the
  test takes, whether that changed and whether the change held. The
  configuration's passes, oldest first, a run that passed only on a
  retry among them with the time of the attempts that passed
  (`passedEventually`, `passed_duration_milliseconds`: a cell's summed time
  would be the failed attempt's, a 300 s crash against a 1 s pass; the
  field is one run's time, the mean over the sibling jobs that passed and
  over a job and its re-run that both passed, so neither counts twice; the
  card times such a run by the pass and gives the whole on a line of its
  own, "N in all", when it is more), are cut into stretches of one typical
  time (`laneTimes`, `stretches`: the level at a pass is the median of the
  five passes around it, a new stretch begins at the first of six passes in
  a row whose level sits more than 15% off the current stretch's median,
  the difference judged against at least a tenth of a second so that a
  fast test's millisecond jitter is no change (`TIME_FLOOR_MS`), and
  neighbours whose medians end up within 15% are merged closest pair first
  until none are; a first stretch shorter than five passes is folded into
  the one after it, since its level would rest on fewer passes than the
  rolling median every other boundary is judged by, so a lane's first run
  alone never makes a stretch; `TIME_ROLL`, `TIME_THRESHOLD`, `TIME_HOLD`).
  Each stretch is a block from its newest pass's column to its oldest's,
  the oldest stretch at the right end of the bar, labelled with its median
  time, "42 s", the oldest in a neutral grey and the newer ones tinted
  against its time (`stretchTone`, `stretchColors`: within a tenth the same
  grey, slower the failed hue's pale background and edge, faster the passed
  hue's, since slower is the bad news), the change on the stretch before,
  the block to its right, written at the block's left end, "+44% · 1.0
  min", the figure in the hue's ink; a block too narrow for both shows its
  time alone, a narrower one its change alone, a narrower one nothing
  (`estimatedTextWidth`; the time before the change, since the tint already
  says which way a change went). A block with no room for any of it writes
  its label to its right, in the room before the older block or the plot's
  end, with the same order of preference (`stretchLabel`), and a lone pass
  or two make a block at least `GRID_SIZES.stretchMinWidth` wide, a stub
  for the label to follow, the stub reaching rightward under the older
  block, which is drawn over it. The
  pointer on any block outlines the block in its ink and brings the card
  with the stretch's time, its change, how many passes it spans and from
  when to when (`Hover.part`, `stretchAtColumn`), so a stretch too short
  for a label is still read by sweeping the bar; a click there opens
  nothing. A configuration with passes is a 40px lane, its pills on the
  upper row (`laneHeightFor`, `gridRows`, `GRID_SIZES.pillRowCenter`,
  `timeBarTop`). One slow run never makes a stretch, so a stretch is by
  construction a sustained change, and its length says how long the change
  has held: the two things wanted, whether the time changed and whether the
  change held, are facts about stretches of runs, which a graph of each
  run's time would leave to the reader. The hover card gives each run's own
  time in its headline, "Passed · Oct 27, 10:33 AM · 4.2 s", and names its
  stretch, "In a stretch at 1.0 min, +44% on the stretch before".

  Days are marked by a hairline and a label in the footer, "Wed, Oct 28",
  when the day is wide enough for it, weekends by a faint band. The footer
  is its own strip under the drawing, the day labels with a short tick
  where the day changes and the commit pills, and it sticks to the bottom
  of the viewport while the grid runs taller than the screen, as the header
  band sticks to the top with the titles and the keys (`position: sticky`),
  so neither scrolls out of sight; the pointer over the strip still names
  the column under it. While a commit is pinned from the search field the
  strip has a second row, 22px, for the pinned pill, under the day labels
  and the pointer's pill (`footerHeight`, `GRID_SIZES.pinnedRowHeight`), so
  the two pills never cover each other. While the plot is wider than its
  room the strip has a row at its bottom edge, 10px, for the thin
  scrollbar that scrolls the plot and the day labels together
  (`GRID_SIZES.scrollbarRowHeight`), in reach however tall the grid, since
  the strip sticks to the viewport's bottom.

  Every text in the table can be selected and copied, the titles, the
  workflows' names, the labels, the counts and the day labels: nothing sets
  `user-select`, and the SVG's texts select as HTML text does.

  Hovering a column bands it across every lane in a wash of orange and
  names the commit in a solid orange pill in the footer, its short SHA and
  the time of the test's first attempt on it, in dark text, white on the
  orange falling short of the contrast small text needs (a grey band and
  pill were easy to miss; the blue is the pins', which stay, while the
  pointer's mark is transient, so the yellow pills the orange dims are only
  under the pointer). The cell under the pointer grows by 2px on every side
  over its neighbors (`CELL_HOVER_GROWTH`), its fill steps a shade deeper
  than its edge and a ring in the block's text shade, the block's ink,
  surrounds it (`cellHoverColors`), the ring the list's health blocks show
  when hovered, drawn inside the grown box as the edge is, so a split run's
  two capsules grow as two with their gap kept. The plot reaches as far
  past its first and last columns as a cell grows (`PLOT_INSET`: on the
  left out of the gap after the Outcomes column, so the first column stays
  put; on the right out of the columns' room), so a cell at either end
  grows whole: the drawing's edge had cut the newest cell's left side off.
  Hovering a cell opens a
  card above it, or beneath it when the card would climb out of the body or
  under the header stuck to the viewport's top: how it ended ("Flaky" for a
  run that recovered, else its recorded outcome, "Timed out") and when, the
  workflow and lane, then each job of the cell under its name, the jobs
  that decided it first (`cardJobs`), with its attempts in order as pills
  in their outcomes' colors with an arrow from one to the next, "Crashed →
  Passed" (`AttemptPills`, `attemptStatus`, `attemptPillColors`: the health
  blocks' background and ink) and its time when it executed anything, the
  whole spend on a line of its own, "N in all", when it is more than the
  headline's (`cellTime`), and that a click opens the job that decided it
  on GitHub, which it does. A lane with no run on that commit says so ("No
  run shown" while the grid is narrowed, since the run may be one of the
  outcomes left out). The grid is drawn in SVG from the page's own column
  width (a `ResizeObserver`); a skeleton holds its place while it loads, a
  failure is a `LoadError` with Retry, and a grid with no lane says "No runs
  on main in the last 3 days." in the sentence's own words. Not yet done:
  keyboard access to the cells, and the commit's title or a link to its HUD
  page, which the runs tables do not carry.

## Commit page

`/tests/[organization]/[repo]/commit/[sha]` is one commit's page: what happened
to the repository's tests on that commit, built on
`GET /api/tests/commit/{sha}/summary` for its header and summary row,
`GET /api/tests/commit/{sha}` for its table and
`GET /api/tests/commit/{sha}/greenlight` for the header's GreenLight pill. It
keeps the rules above: nothing but `/api/tests` endpoints, types and parameter
definitions only from `lib/api/`, the theme's colors, logic in `lib/tests/`
(`lib/tests/commit.ts`, `lib/tests/commitPage.ts`, `lib/tests/bundle.ts`,
`lib/tests/jobName.ts`, `lib/tests/greenlight.ts`, tested in `test/tests/`),
and the hub's components: the header pieces
(`PageHeader`, `FactPill`), the Name, Environment, Test Config and Owners
columns (`sharedColumns`), the hub's grid (`HubDataGrid`), the Health cell's
block (`CellBlock`), the grid's swatches and attempt pills.

- The summary (`useCommitSummary`) and the runs (`useRunsListing`) are
  asked for at once, in parallel. The summary's counts read every run of the
  commit, a few seconds on a main commit (outside the database's heavy
  workload since 2026-11-05, so the header no longer waits behind tests
  pages); the runs come a page of the API's largest size at a time, in
  outcome order (the API's `-status` sort, worst first, which the page puts
  before its own), and with the default outcomes the read is pruned to the
  rows of the tests holding a failing row, in under a second. A commit
  GitHub never reported (the API's 404) is a state of the page, not an
  error; a known commit with no runs says whether they expired
  (`retention_starts_at` against `committed_at`) or have not arrived, and
  shows no summary row. When the summary fails, its error shows above the
  table and the runs are listed all the same, since the two are separate
  requests (2026-11-02).
- The header (`CommitHeader`): the breadcrumb is the repository, the branch
  (HUD's view of it) or the pull request's number for a pull request head,
  and the short SHA, the page itself, which is not a link. The headline is
  the commit title with its trailing `(#N)` taken off; backtick
  spans are code; a `#N` inside
  the title, as the merge bot's reverts name the reverted pull request,
  links that pull request too (`headline`). The facts are, after
  GreenLight's pill, the pull request and the commit as one pill
  (`PullRequestAndCommit`): the pull request's, "PR #204150" in the facts'
  grey, linking the pull request, for a pull request head and a merged
  commit alike (`commitPullRequestNumber`: the API's pull request, else the
  title's), with the commit's short SHA in monospace set inside its end as
  a chip, linking the commit on GitHub, the full SHA its tooltip. A pull
  request from a fork gets it too: its runs record no pull request at all
  (2026-11-02: 333 of 333 fork heads in two days had an empty
  `pull_requests` array, their ciflow tag pushes included), so the API
  finds it by the commit's SHA through `materialized_views.pr_by_sha` and
  names the fork's branch as Branch. A commit of no pull request, a merge
  bot's revert, has the same pill saying "Commit", the chip its value and
  the whole pill its one link, so the SHA looks the same on every commit.
  Then come the author, when
  it was committed, and on a branch the nearest commits with test jobs
  either way, the older to the left and the newer to the right, each by its
  short SHA, or for a pull request head its branch. A bright orange "Newer
  commit available" pill, shown on a pull request head the pull request had
  been pushed to since, was built and then removed on 2026-11-02 at the
  user's ask; the header has no attention tone.
- The pull request and the commit were two pills until 2026-11-11, the
  pull request's in GitHub's blue since 2026-11-02 (after a muted number
  behind the title and a pill before it). The user: "The PR pill is
  currently blue. I want to make it grey", and asked for the two as one
  pill, "combined + layered". Of four drawn (nested, stacked, two-tone,
  split) they chose the nested one. The blue tone is gone from `FactPill`
  with its one use: color in a header says a status and nothing else. The
  chip (`FactPill`'s `chip`, `pillChipColors`) is the page's own background
  on the pill's grey, the look a header key has on the band, 2px inside
  the pill's end so the two ends are concentric; a faint shadow lifts it in
  the light mode and a faint edge marks it in the dark one. The SHA has no
  word beside it inside the pull request, where it reads as that pull
  request's commit; its link is named "Commit 573c889" for a reader who
  does not see it. The pill holds two links and each answers alone: the
  pointer on the pill's words darkens the pill (`:has`, as `HeaderCheck`
  uses it), on the chip it rings the chip; from the keyboard the pull
  request's link rings the whole pill and the commit's the chip. The chip
  is pressed over the pill's whole height and out to its end, not only
  where it is drawn. The pill is 171px wide where the two were 238px.
- GreenLight's verdict is the first pill of the facts (`GreenLightPill`,
  2026-11-11; first at the user's ask, the first build had it last), from
  `GET /api/tests/commit/{sha}/greenlight` (`useCommitGreenlight`): asked
  for alongside the summary, which it does not wait for, and again each
  minute only while a review is in flight. It is a status pill in the hub's
  hues (`tonePillColors`): a lamp, "Green Light" and the verdict in a word
  or three (`greenlightSignal` in `lib/tests/greenlight.ts`). The colors
  are the user's (2026-11-11). Green is "Approved". Yellow is "Needs human
  review" and "Reverted". The facts' grey is everything with no verdict,
  its lamp hollow: "No verdict", "Unavailable", and a review that reached
  none, by how it ended, "Inference failed", "Inference cancelled",
  "Inference stalled" (in flight for over an hour). Red was built for those
  three at the user's ask and withdrawn within the hour ("the red is
  confusing"): do not bring it back, and a refusal stays yellow, since red
  on this page is a failed test. "Reviewing" is grey too, and its lamp
  alone has color: it pulses from the refusal's yellow to the approval's
  green and back, a second each way, a ring leaving it at each turn (`Lamp`
  in `GreenLightPill`). Two other looks were built first and withdrawn the
  same day: the whole pill swinging between the two colors ("The pulsing
  between green and yellow is actually confusing"), then a green pill with
  the pulsing lamp ("No this is not what I meant. Reviewing pill should be
  grey. But the dot should be pulsating with yellow and green"). Do not
  color or move the pill again. For a reader who asked for less motion
  nothing moves and the lamp is a still yellow dot. What a status means is
  not decided here: the sentence, the reason and the hour after which a
  review in flight did not complete are the HUD verdict panel's own
  (`describeGreenlightStatus`), so the two pages say the same.
- Every commit of a repository GreenLight reviews has the pill, whatever
  the answer (the user, 2026-11-11: "We should include the pill if there is
  no verdict or if the inference failed. We should let the user know those
  information"; the first build had no pill for a commit with no verdict or
  for a verdict that failed to load, and said "Did not complete" for an
  inference that failed). A commit with no verdict says "No verdict", and
  its tray what is known of why, from the API's
  `no_verdict_reason`: GreenLight has no review of the commit, or the commit
  is of no pull request (`noVerdictSignal`). A verdict that could not be
  read says "Unavailable", and its tray the failure with a Retry
  (`LoadError`); a refresh that fails leaves the verdict it had
  (`commitGreenlightState`). While the answer is on its way a placeholder
  holds the pill's place (`PillSkeleton`), so the facts after it move by the
  difference in width alone. A repository GreenLight does not review gets no
  pill and no request (`isGreenlightRepo`), and holds no place for one.
- The pill is a button (`FactPill` with `onClick`) and opens a tray, where
  the old page has an accordion (the user's ask: "in the old UI, clicking
  it expands it. Think about how we can better present this in the new
  UI"). The tray unfolds from the pill's own footprint and lies over the
  page, so the summary and the table do not move and closing it leaves the
  reader where they were. For a verdict it holds the sentence for the
  status with its reason code; the review's outline, each topic a title
  over its details (`GreenLightOutline` in the tray's dress, so the model's
  words stay the text nodes they are there: never render the message as
  markup); and at its foot the pull request head the verdict is about, when
  the commit shown is the one that head landed as, when the status was
  recorded, the review's job on GitHub and, for a judgement, "Report wrong
  verdict". It hangs from the pill's left edge while that fits the row of
  pills, else from its right, and never crosses the row (`trayPlacement`);
  it is as wide as what it holds, up to 560px, and as tall, and scrolls
  with the page, never within itself. A click on the pill, a click
  elsewhere or Escape folds it; focus stays on the pill, which says
  `aria-expanded`, names the tray and keeps the look it has under the
  pointer while the tray is open. It is closed on arrival whatever the
  status, where the old panel opens itself for an approval: the pill
  already says the verdict. The motion is the Web Animations API's, 300 ms
  out and 160 ms back, the words leaving before the tray folds, and none
  for a reader who asked for less.
- The report button is the one exception to "no `pages/api/` endpoints": it
  is the HUD's own (`GreenLightReportButton`), reused whole with its dialog
  as it is (the user: "You don't need to stylize the report modal"), so
  that both pages file the same report; it reads the reader's write access
  and posts to `/api/greenlight/report`. It shows only to a signed-in
  reader who may file one, as on the old page, so a signed-out reader's
  tray has none.
- The summary row (`CommitSummaryRow`) is two lines. The counts line: at
  left the statuses with runs, "5 failed · 8 timed out · 87 flaky ·
  4,721,574 passed …", each figure large (22px) and each a button that has
  the table list that outcome alone, led by a green "Every test passed" when
  nothing failed, timed out or was flaky; at right the facts, the total
  tests ("9,177,729 total tests", the API's `counts.total.runs`), the unique
  tests ("672,763 unique tests", `counts.total.tests`), the jobs and the
  wall time (2026-11-02: the total moved from a hero figure at left into the
  facts, and the counts took its place, at the user's ask). In a window too
  narrow for both to share the line, the counts' figures shrink a pixel at a
  time from 22px to the facts' 15px, the gaps between counts in proportion
  (`fittingCountSize` and `countGap` in `lib/tests/commit.ts`, measured in
  place when the row is laid out, resized or gets its fonts), and only past
  that do the facts wrap under the counts (2026-11-02, at the user's ask: the
  second line read as an overflow). Under it a bar of the
  statuses with runs. A run is one test in one environment, env var set and
  job with all its attempts, so a test run in twelve jobs counts twelve
  times, and the counts add up to the total tests. The bar is NOT to scale: a
  segment's width is
  log10(runs + 1), the user's choice (2026-11-01) so that five failures stay
  visible beside millions of passes; nothing on the page says so, and only
  a segment's hover title gives the true share ("Failed: 5 of 9,177,729
  tests, under 0.01%"). The summary's `by_worst_status` counts stay in the
  API; the page does not read them. The row covers the whole commit; the
  search and the column filters narrow the table only.
- The table (`CommitTable`) is the hub's grid with one list of runs in
  outcome order, failed, timed out, flaky, passed, other, expected failures,
  skipped, and within each outcome the headers' sort, longest first by
  default; rows of attempts under an expanded run and a "Show more" row are
  rows of the grid too (`commitTableRows`). The Outcome header's filter
  chooses the outcomes listed: passes, skips and expected failures are off
  by default (`COMMIT_PAGE_DEFAULT_STATUSES`), so its key reads active. A
  run is listed once under its own status, so a test failed in one job and
  flaky in another has a row in each while the summary counts it once. The
  page asks for the pages after the first by itself, under the table's
  progress bar, while the last row loaded is not of a common outcome
  (passed, skipped, expected failures) and the list holds fewer than
  `AUTO_LIMIT` rows (`autoLoads`; three pages since 2026-11-02, ten before,
  which on a commit that broke trunk meant ten reads of its runs and a
  thousand unvirtualized rows before "Show more"); from a page ending in one of those on,
  "Show more" asks a page at a time, though `other` follows passed in the
  order, so a page ending on an other row resumes the loading. The
  API does every sort; Duration is the run's executed time, skips left out,
  the API's `duration_milliseconds`. The chevron before a name opens the
  run's attempts, lined up with the columns; consecutive attempts with one
  outcome and one first message line, temp paths ignored, share a row
  (`attemptGroups`).
- The URL keeps the view: `search`, the column filters named as on the list
  (`owner`, `test_config`, `workflow_path`, the environment facets),
  `status`, repeated once per outcome as the API's is, and `sort`, defined
  in `lib/api/tests/pages/parameters.ts` and
  documented by the `commitPage` operation; defaults are left off and
  changes replace the entry in place, read from the state in force when the
  change is made, so a filter chosen during the search's pause is kept.
  Expanded attempts are not kept, and another commit starts them over.

## Pull request page

`/tests/[organization]/[repo]/pull/[number]` is a way to a pull request's
newest commit: it asks `GET /api/tests/pull/{number}` for the pull request's
newest head (`usePullRequestHead`) and opens that commit's page in its place
with `router.replace`, so the browser's back button skips it. A link to it,
unlike a link to a commit, stays current as the pull request moves. It keeps
the rules above: nothing but `/api/tests` endpoints, its logic in
`lib/tests/pullPage.ts`, tested in `test/tests/pullPage.test.ts`.

- The commit page's parameters in its URL are passed on, read and written as
  the commit page reads and writes them (`pullPageTarget`), so
  `/tests/pytorch/pytorch/pull/203277?status=passed` opens the newest commit
  listing its passes.
- Until the head is known the page shows the commit page's own loading
  header (`CommitHeader` with no commit), so the commit page arrives without
  a jump.
- Each visit asks afresh, in an SWR cache of its own (`VISIT_CACHE`, an
  `SWRConfig` provider around the page). From the shared cache a later visit
  in the same tab got the head the first visit found and opened it at once,
  since SWR shows a cached answer first and asks again only on the next
  animation frame, though the pull request may have moved on since (found in
  review, 2026-11-05).
- The head is HUD's, not GitHub's: the head the pull request's latest record
  names, corrected when that record fell behind a push (the API README's
  [Pull requests](../../app/api/README.md#pull-requests)). A push that has
  not reached HUD yet, seconds old, is not seen, and the page opens the head
  before it.
- A number HUD has no pull request record for shows a warning under the
  headline "Pull request #N", with no Retry; any other failure, a malformed
  number among them, shows the API's error with a Retry (`LoadError`).

## Cost page

`/tests/[organization]/[repo]/cost` is a prototype: where a repository's
test-job runner-hours went over the last 1, 3 or 7 whole UTC days, by owner,
machine and workflow at once, from one answer of `GET /api/tests/cost` summed
in the browser (`lib/tests/cost/runnerHours.ts`, tested in
`test/tests/cost.test.ts`). The API README's
[Cost](../../app/api/README.md#cost) section has the method.

- Three rules hold throughout. The window and the workflow scope are the only
  choices that change the numbers: owners and machines highlight, and nothing
  re-sorts or rescales when they do. Every number carries its unit, and every
  percentage its base: the owner bars, their axis and the machine key are
  shares of the scope, the workflows card shares of the whole window. Colors
  follow the machine: the window's seven largest keep seven validated hues in
  name order (`lib/tests/cost/colors.ts`), other machines are grey, and a
  highlighted machine without a hue takes the accent. Hours whose machine is
  estimated from a runner label are striped in their machine's color;
  Unknown machine is grey stripes at the other angle.
- The title is a sentence, as the tests page's is: "Runner-hours of
  pytorch/pytorch over the last 7 days", the window (1, 3 or 7 days) its pill
  (`InlineSelect`). The facts under it say what the hours cover: the scope (in
  the accent with a clear button while one is in force), annualized and per
  day runner-hours, the share attributed to owners, and the PR update and PR
  merge signals (pull and trunk on pushes to main, medians with queueing),
  which ignore the scope. Each panel's subtitle names the days its answer
  covers, and how many of the window's days have data when not all do. Every
  tooltip and caption is a phrase or two.
- Runner-hours by owner: the top 15 owners, every highlighted owner in its
  own row, "N more owners" (opens to list them), then one Unattributed row
  with an (i) defining it, each bar split by machine in one fixed order (the
  window's largest first, Unknown machine last). Highlighted machines move to
  the start of every bar and the rest goes pale; highlighted owners dim the
  other rows. The band holds the scope keys (All workflows, the API's presets
  such as PR Critical Path, and Custom while the workflows card sets one) and
  "Split by machine". The machine key at the right is legend, machine picker
  and machine shares in one.
- All owner–machine pairs: the matrix, open until its band folds it. Its rows
  end with the two unattributed buckets, No owner then No test reports, each
  with an (i). Cells show an owner's share of the machine (default), the
  machine's share of the owner, or hours on a square-root scale, by one
  sequential blue ramp in light and dark steps; cells that are mostly
  estimated are striped. "Only selected" hides what is not
  highlighted, every number unchanged; "Download CSV" saves the rows in the
  scope and highlight. Columns group by machine family. A cell opens a drawer
  at the right: its hours and their bases, how many have an estimated
  machine, its workflows, the runner labels mapped to the machine, for a
  bucket what it is made of (runner labels or files), and caveats. Headers,
  row names and cells are buttons, so all of it works from the keyboard.
  Escape closes the drawer, then clears the highlight, unless a text field or
  menu has it.
- Cost by owner (`CostPanel`), under the runner-hours chart: the same chart in
  $, from a rates file the reader adds, so the page never asks for a unit up
  front. Until a file is added the panel's body asks for one: a dashed area to
  drop it on (a file dropped anywhere on the page lands there, so a miss never
  opens the file in the tab), "Download rates file", "Choose rates file…" and
  "File format" (a JSON of runner label → $ per runner-hour, or wrapped as
  `{valid_from, window, basis, rates}`; `window` is `{start, end}`, the UTC
  days of usage the rates are averaged over, both included, and a bad one is
  ignored as the notes are). "Download rates file" is a plain link to the
  internal rates file (`RATES_FILE_URL`, a Meta-only fburl; its tooltip says
  it needs access to the file) that opens in a new tab: the browser downloads
  the file and the reader adds it as any other; HUD never fetches it. The file
  is read in the browser into the page's state (`lib/tests/cost/rates.ts`):
  never sent, stored, or put in the URL, whose query HUD's analytics record,
  and reloading drops it; the panel's split keys stay out of the URL with it.
  The API holds no prices. A row's price key is its runner labels without
  self-hosted; 0 is a price, and a runner the file leaves out has no rate and
  stays out of the cost. Once added, a line under the band names the file, its
  usage window in a grey pill like the facts' (the page's date format, "Rates
  averaged over 2026-10-08 to 11-06"; its tooltip counts the UTC days and says
  the page prices all its days with these rates), its valid_from unless that
  is the window's last day, its basis, how many of the window's runners it
  leaves without a rate and how many of its labels didn't run (each listed in
  a tooltip), and Replace, Clear and File format (the facts' "Priced" pill is
  the share, by scope); a file that can't be read says why, keeping the one
  loaded, and a file pricing no runner in the window is refused, with an
  example label. Rates run from 0 to 100,000 $/h and read to 3 significant
  figures under $1. Each runner's $/h in the key is editable in place
  (`RateCell`: a click or Enter makes it a field, Enter or leaving applies,
  Escape cancels, blank removes the rate, a hint shows while what is typed
  is no rate), the page repricing at once; edited rates are in the accent,
  and the file's line counts them (each change in a tooltip) with an inline
  "(Undo)". The runners drawer finds its row again on every change, as the
  matrix's cell drawer does, and closes when the row is gone. A file dropped
  anywhere on the page is never opened in a tab, even before the panel is
  there. The field is in no form and has no name,
  so the browser neither submits nor remembers it; edits live in the page's
  state with the file. Owners sort by
  $, and a mark on each bar is its share of the runner-hours that have a
  rate, on the axis's share scale (where the bar would end at the scope's
  average $/h), so owners whose hours cost more than average stand out. The panel follows the page's workflow scope and
  highlight; machines keep their runner-hours order and hues, so nothing
  repaints, and owners and machines with hours but no rate keep their rows.
  With a file, the facts gain a second row in $ (annualized, per day, and
  the share of the scope's runner-hours priced), following the scope and
  any edits; the matrix and the workflows card stay in runner-hours.
- Runners, in the cost panel only (runner names matter where they are
  priced; the runner-hours chart is as it was): each split bar piece's
  tooltip names the runners it ran on; a row's › opens a drawer of its
  machines and each machine's runners with their shares, $/h and cost, and
  the runners with no rate; the machine key (`CostMachineKey`) gives each
  machine its $/h and a ▸ listing its runners with theirs, in the runner
  level's shades and order, every figure of one set (every owner, or the
  highlighted owners', the pale bars still every owner's, so a machine's
  runners add up to it), a highlighted machine's runners open and the others
  dimmed with theirs, each runner in a shade of its machine's color in a
  fixed order (its window hours, largest first, darkest). Every runner figure
  follows the workflow scope. The answer's rows keep
  their runner label for this.
- Workflows: the four largest, ticked ones pinned, "+ N more" with a search;
  ticking makes a custom scope. Open, under the matrix (2026-11-04: folded,
  it was easy to miss).
- The URL carries `window`, `workflow`, `owner` and `machine` (repeated),
  `split_by`, `cells` and `only`, defined in `lib/api/tests/cost/page.ts`
  (`COST_PAGE_PARAMETER_DEFINITIONS`, `window` taken from the endpoint's
  definition). Names the answer does not hold are dropped from the page at
  once and from the URL with the next change (`knownChoices`), except on a
  window change, whose new answer may hold them.

## Verifying a change

- `yarn test test/tests` runs the unit tests for the glue and the cells, and
  for the test page's title, hook and request helpers
  (`test/tests/testPage.test.tsx`).
- `npx tsc --noEmit` and `npx eslint` on the touched files; `yarn format`.
- `yarn dev` with the ClickHouse credentials local development uses, then open
  `/tests/pytorch/pytorch` and check both themes, each header in both
  directions, no header label moving when hovered or sorted, the duration
  header on two lines whether or not it is sorted or hovered, each choice in
  the title, each header key's menu (the Environment menu's eleven rows in
  view at once, a row unfolded and folded again, a low row scrolled up, the
  key filled in the accent once something is chosen, the label still
  sorting), a token clicked in an Environment cell and in a Config cell (the
  key and the URL follow), text typed in the Name header's search (the
  skeleton at once, the URL after the pause, the earlier request aborted when
  typing goes on, focus kept), a file and a suite clicked in a Name cell, the
  clear button and Escape, the environment tooltip, the case name, the
  Health block or healthy word and the duration figure as links (the name
  bare, the two figures carrying `window=`, `ran_on=`, `environment=` and
  `env_vars=`; underlined at full strength on hover where the tokens are
  grey; a drag across each selecting its text without leaving the page;
  Cmd-click opening a tab), the softened repeats when sorted by
  Environment, next and
  previous, a page size change, each view chip (the title, the header keys,
  the sort arrow and the URL follow; the chip stays chosen through a filter
  or a window change and leaves when its own sort changes, Least healthy is
  chosen on a bare URL, Blocking viable/strict leaves outside 12 hours, and a click on a chosen chip keeps the added filter), an
  empty repository (`/tests/pytorch/no-such-repo`), an invalid sort (`?sort=bogus`) and a
  choice the options do not offer (`?window=5d` or `?device_name=none`, which
  show the default), and a URL carrying exact name filters
  (`?file=test/test_torch.py&case_name=test_add`: chips in the Name header,
  the table narrowed to them, each chip's button taking its value out, and
  the `hud_url` of `/api/tests?repo=pytorch/pytorch&file=test/test_torch.py`
  opening the same table). `/api/tests/options` itself is a plain JSON page
  to look at. The grid only mounts on the client, so the server-rendered HTML shows
  the heading alone; judge the table in a browser.
- For the test page, open `/tests/pytorch/pytorch/test/<id>` with an id from
  the list (`/api/tests?repo=pytorch/pytorch&limit=1`) and check the header
  in both themes, each crumb's link (the list, then searched by file, then by
  file and suite), a long case name wrapping at its joints, the three pills
  and the first-seen tooltip, a
  module-level function (no suite crumb), an unknown id (`/test/1`, the
  warning), a malformed id (`/test/abc`, the API's error with Retry), a test
  of another repository (its id under `/tests/pytorch/vision/`, the warning)
  and, with `HUD_API_REQUIRE_AUTH=1`, that it all loads signed out.
  Then the grid, in both themes: the five header keys and their URL
  parameters (the commit search with a hash in and out of the window and
  its messages, `commit=`; code source and window, `ran_on=`, `window=`;
  the outcomes shown, `outcomes=`, and its empty sentence; the time bar
  checkbox, `time_bar=0`, unticked and disabled on pull requests); the plot
  scrolling under the fixed columns on pull requests, the footer's
  scrollbar and day labels in step with it and a found commit scrolled
  into view; a split run's two capsules; the hover card over
  a cell, over a stretch of the time bar and over an empty column, and that
  it stays clear of the header stuck to the viewport's top on a grid taller
  than the window; a click opening the decisive job; the `+N vars` badge
  opening its panel by click, Enter and Space; the pinned commit's band and
  footer pill; the code sources key with both chosen
  (`ran_on=main,pull_request`, the key reading "main and pull requests"); a
  Health block clicked on the list landing on its configuration's lanes
  banded in blue and scrolled into view, the strip unpinning by click,
  Enter and Space, and a pin naming no lane (`?environment=1&env_vars=1`)
  said above the rows with its Unpin; the sticky header and footer while
  scrolling; and the Retry of a failed options load asking the options
  again.
- For the commit page's GreenLight pill, open
  `/tests/pytorch/pytorch/commit/<sha>` for a head GreenLight reviewed (the
  heads of a recent pull request with a Green Light section in its Dr.CI
  comment; `/api/tests/commit/<sha>/greenlight?repo=pytorch/pytorch` is a
  plain JSON page to look at) and check, in both themes: the pill first in
  the facts, in the verdict's tone; a review in flight in grey, its lamp
  alone pulsing between yellow and green, and the lamp a still yellow dot
  with the browser's reduced-motion emulation on; "No verdict" on a commit
  GreenLight did not review, most of main; "Unavailable" and its Retry with
  the request
  blocked in the browser's network tools; no pill under another repository
  (`/tests/pytorch/vision/commit/<sha>`); the placeholder holding the pill's
  place on a slow connection; the tray opening by click, Enter and Space and
  folding by each of them, by Escape, with focus back on the pill, and by a
  click elsewhere, but not by a click inside it; the summary and the table
  not moving; the tray within the row of pills in a narrow window; a merged
  commit's tray naming the pull request head and linking its page; and,
  signed in with write access, "Report wrong verdict" opening its dialog
  over the tray (do not file one to test). The sign-in completes only on
  the host `NEXTAUTH_URL` names, so a dev server opened by another name
  shows no report button. Jest has no DOM, so the unfolding itself is only
  seen here; slow it with the browser's animation tools.
- For the commit header's pull request and commit pill, open a pull request
  head, a commit on main and a merge bot's revert (a `Revert "..."` on main,
  which has no pull request of its own) and check, in both themes: one grey
  pill, the SHA a chip inside its end; the pointer on "PR #N" darkening the
  pill and on the chip ringing the chip alone; Tab reaching the pull request,
  the pill ringed, and then the commit, the chip ringed; a press just above
  or below the chip, still within the pill, opening the commit; and the
  revert's pill saying "Commit" and opening the commit wherever it is
  pressed.
- For the pull request page, open `/tests/pytorch/pytorch/pull/<number>` for
  an open pull request of pytorch/pytorch and check that the URL becomes the
  page of the head `gh pr view <number> --json headRefOid` names, that back
  skips the pull request page, that `?status=passed` is passed on, and that
  an unknown number (`/pull/999999999`, the warning) and a malformed one
  (`/pull/abc`, the API's error with Retry) say so.

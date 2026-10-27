# Tests page

`/tests/[organization]/[repo]` lists a repository's tests: the test hub's main
page, built on the [HUD API](../../app/api/README.md)'s `GET /api/tests`.
`/tests` redirects to `/tests/pytorch/pytorch` (a `redirects()` entry in
`next.config.js`); the HUD navigation bar does not link to the page. The other
files in `pages/tests/` (`search.tsx`, `fileReport.tsx`, `testInfo.tsx`)
predate it, read `pages/api/flaky-tests/`, and follow none of the conventions
below.

This file is for the people who work on the page: the rules it keeps, where
its pieces live, and the decisions that are not obvious from the code. The
[OpenAPI document](https://hud.pytorch.org/api/openapi.json) is the reference
for the data it shows.

## Best Practice

- The page never queries the database. Every byte it shows comes from an
  endpoint under `/api/tests`: no ClickHouse client, no SQL, no
  `queryClickhouse`, no `/api/clickhouse` named queries, no `pages/api/`
  endpoints. The API is the one contract: it validates parameters, documents
  its response, hands out cursors, and is where queries are measured and
  optimized. When the page needs data the API does not have, extend the API
  first, following its README, then the page.
- Import only types from `lib/api/` (`import type { ... }`), so the server's
  zod schemas and database client stay out of the client bundle. The page
  depends on the API's response shape, nothing deeper.
- Spell out no API value. The title's choices, their labels and their
  defaults come from `GET /api/tests/options` at run time
  (`useTestsOptions`), so a window, code source or language added to or
  removed from the API, a device, Python version or workflow newly recorded,
  or a default changed there, reaches the page with no page change.
  The page reads the options first, resolves the URL against them
  (`resolveTestsQuery`), and only then asks for the list, naming its
  `window`, `ran_on`, any `language` and any facet value explicitly: the
  request says exactly what the sentence shows, even if a deploy lands
  between the two requests. The page knows the API's parameter _names_, the
  fifteen facets in `lib/tests/facets.ts`, which the compiler checks against
  the options' type, and never their values; the labels of the environment
  cells come from the options too. The one API default still written down is
  the sort, `DEFAULT_TESTS_SORT`, which the options do not cover.
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
- `search` carries the Name header's search text as typed, under the API's
  own parameter, and is left off when empty. Typing does not write the URL at
  once: the text is held on the page (`typedSearch`) and the URL follows
  after a 250 ms pause in typing, by `router.replace`, so a keystroke neither
  fetches a page nor adds a history entry. A file or suite clicked in a cell,
  or Enter in the field, writes the URL at once with `router.push`. Until the
  URL has caught up the listing is told the query is pending.
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
- Every cell's text can be selected and copied, the text that acts included:
  a drag across a token, a file, a suite or a Health block selects it like
  any other text, and the click that ends the drag does nothing
  (`endsTextSelection` in `lib/tests/selection.ts`, which `TextButton` and
  `CellBlock` consult), so the table does not reload under a selection the
  reader just made; a plain click, or Enter or Space on the control, still
  acts. The controls are spans with the button role, not `<button>`s, whose
  text not every browser lets a reader select, and they override MUI
  ButtonBase's `user-select: none`. Ctrl+C with text selected copies the
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
- The page is one fixed-width column, centered, so the table does not
  stretch with the window: as wide as the table with every column at its
  width (`TESTS_TABLE_WIDTH`, the Name column at its 480px minimum), so at
  full width the table is whole and never scrolled sideways. The widths are
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
  (`columnHeaderHeight`) and holds its two-line label the same way. The separator is a grey two steps off the band in each mode: the
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
  and shows at once. Once the retries are spent the API's error text shows
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
  frame, the unremarkable case the blocks stand out of. Every word is a
  filter token: clicking it, or the block, shows only that status, and the
  header's key offers all four. The tooltip lists every count and rate
  (`DetailList`, which the Environment tooltip shares). The header sorts
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
  text, with the mean to the millisecond ("12,695 ms") as the tooltip. The two lines are the Health cell's (`CellLines` in `CellBlock.tsx`) without its frame, placed by the cell's own padding. Coloring slow means by tiers (yellow over 10 minutes, orange over 15, red over 20, in the Health cell's blocks) was tried on 2026-10-25 and taken out again as too much: the figures stay plain. The line heights are tightened to 1.25 so the two lines fit the row, and the
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

## Verifying a change

- `yarn test test/tests` runs the unit tests for the glue and the cells.
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
  clear button and Escape, the environment tooltip, the softened repeats when sorted by
  Environment, next and
  previous, a page size change, each view chip (the title, the header keys,
  the sort arrow and the URL follow; the chip stays chosen through a filter
  or a window change and leaves when its own sort changes, Least healthy is
  chosen on a bare URL, Blocking viable/strict leaves outside 12 hours, and a click on a chosen chip keeps the added filter), an
  empty repository (`/tests/pytorch/no-such-repo`), an invalid sort (`?sort=bogus`) and a
  choice the options do not offer (`?window=5d` or `?device_name=none`, which
  show the default). `/api/tests/options` itself is a plain JSON page to look
  at. The grid only mounts on the client, so the server-rendered HTML shows
  the heading alone; judge the table in a browser.

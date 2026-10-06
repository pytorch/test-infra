import { PassingCodeSkipRow } from "lib/types";
import { Octokit } from "octokit";

export const PYTORCH = "pytorch";

// Stable title, same idea as a DISABLED issue title: one open batch, not a
// new pull request every time the bot runs.
export const CODE_SKIP_UNSKIP_PR_TITLE =
  "Unskip code skips that passed rerun-disabled-tests";

export const CODE_SKIP_UNSKIP_BRANCH = "unskip-code-skips-rerun-disabled-tests";

// Last 7 days and 150 greens match fetchDisabledNonFlakyTests / the issue closer.
export const CODE_SKIP_WINDOW_DAYS = 7;
export const CODE_SKIP_MIN_GREEN = 150;

// Same phrases as torch/testing/_internal/rerun_code_skip.py. A stored reason
// that contains one of these is "this API is not there", not a known failure.
const UNSUPPORTED_API_MARKERS = [
  "ptx",
  "cuda-specific",
  "cuda specific",
  "hipblas",
  "nvidia-only",
  "nvidia only",
];

export interface OmittedCodeSkip {
  row: PassingCodeSkipRow;
  reason: string;
}

export interface FileEdit {
  path: string;
  content: string;
}

export interface CodeSkipPlan {
  removed: PassingCodeSkipRow[];
  omitted: OmittedCodeSkip[];
  files: FileEdit[];
}

interface DecoratorBlock {
  start: number;
  end: number;
  text: string;
  name: string;
  unclosed: boolean;
}

interface FunctionRecord {
  name: string;
  defLine: number;
  indent: string;
  decorators: DecoratorBlock[];
  className: string | null;
  classLine: number | null;
  classDecorators: DecoratorBlock[];
}

type QuoteKind = "'" | '"' | "'''" | '"""';

export function reasonIsCapabilitySkip(reason: string): boolean {
  const text = reason.toLowerCase();
  return UNSUPPORTED_API_MARKERS.some((marker) => text.includes(marker));
}

export function reasonIsKnownBug(reason: string): boolean {
  const text = reason.toLowerCase();
  if (reasonIsCapabilitySkip(text)) {
    return false;
  }
  if (text.includes("github.com/") && text.includes("/issues/")) {
    return true;
  }
  if (
    text.includes("doesn't currently work") ||
    text.includes("does not currently work")
  ) {
    return true;
  }
  if (text.includes("numerical")) {
    return true;
  }
  return false;
}

export function repoPathForTestFile(filename: string): string {
  const normalized = filename.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.startsWith("test/")) {
    return normalized;
  }
  const marker = "/test/";
  const idx = normalized.lastIndexOf(marker);
  if (idx >= 0) {
    return normalized.slice(idx + 1);
  }
  return `test/${normalized}`;
}

export function testClassName(classname: string): string | null {
  const last = classname.split(".").pop() ?? "";
  if (/^[A-Z]/.test(last)) {
    return last;
  }
  return null;
}

function leadingWhitespace(line: string): string {
  return line.match(/^\s*/)?.[0] ?? "";
}

function scanLine(
  line: string,
  depth: number,
  quote: QuoteKind | null
): { depth: number; quote: QuoteKind | null } {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (quote) {
      if (quote.length === 3) {
        if (line.startsWith(quote, i)) {
          quote = null;
          i += 3;
          continue;
        }
        i++;
        continue;
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
      }
      i++;
      continue;
    }
    if (c === "#") {
      break;
    }
    if (c === '"' || c === "'") {
      const triple = c + c + c;
      if (line.startsWith(triple, i)) {
        const close = line.indexOf(triple, i + 3);
        if (close === -1) {
          return { depth, quote: triple as QuoteKind };
        }
        i = close + 3;
        continue;
      }
      quote = c;
      i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
    }
    i++;
  }
  return { depth, quote };
}

function decoratorQualifiedName(firstLine: string): string {
  const match = firstLine.match(/@\s*([A-Za-z_][\w.]*)/);
  return match ? match[1] : "";
}

function readDecorator(lines: string[], start: number): DecoratorBlock {
  const indent = leadingWhitespace(lines[start]);
  let depth = 0;
  let quote: QuoteKind | null = null;
  for (let i = start; i < lines.length; i++) {
    if (i > start && quote === null && depth <= 0) {
      break;
    }
    const trimmed = lines[i].trim();
    const lineIndent = leadingWhitespace(lines[i]);
    if (
      i > start &&
      quote === null &&
      depth > 0 &&
      lineIndent.length <= indent.length &&
      (/^(async\s+)?def\s+/.test(trimmed) || trimmed.startsWith("class "))
    ) {
      return {
        start,
        end: i - 1,
        text: lines.slice(start, i).join("\n"),
        name: decoratorQualifiedName(lines[start]),
        unclosed: true,
      };
    }
    const next = scanLine(lines[i], depth, quote);
    depth = next.depth;
    quote = next.quote;
    if (quote === null && depth <= 0) {
      return {
        start,
        end: i,
        text: lines.slice(start, i + 1).join("\n"),
        name: decoratorQualifiedName(lines[start]),
        unclosed: false,
      };
    }
  }
  return {
    start,
    end: lines.length - 1,
    text: lines.slice(start).join("\n"),
    name: decoratorQualifiedName(lines[start]),
    unclosed: true,
  };
}

function splitSource(source: string): {
  lines: string[];
  newline: string;
  trailing: boolean;
} {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const trailing = source.endsWith("\n");
  const lines = source.split(/\r?\n/);
  if (trailing && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return { lines, newline, trailing };
}

function indexFunctions(source: string): FunctionRecord[] {
  const { lines } = splitSource(source);
  const records: FunctionRecord[] = [];
  const classStack: {
    name: string;
    indent: string;
    line: number;
    decorators: DecoratorBlock[];
  }[] = [];
  let pending: DecoratorBlock[] = [];
  let pendingIndent: string | null = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const indent = leadingWhitespace(line);
    const trimmed = line.slice(indent.length);
    if (trimmed.startsWith("@")) {
      const block = readDecorator(lines, i);
      if (pendingIndent !== null && pendingIndent !== indent) {
        pending = [];
      }
      pendingIndent = indent;
      pending.push(block);
      i = block.end + 1;
      continue;
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_]\w*)/);
    if (classMatch) {
      const classDecorators = pendingIndent === indent ? pending : [];
      pending = [];
      pendingIndent = null;
      const kept = classStack.filter(
        (cls) => cls.indent.length < indent.length
      );
      classStack.length = 0;
      classStack.push(...kept);
      classStack.push({
        name: classMatch[1],
        indent,
        line: i,
        decorators: classDecorators,
      });
      i++;
      continue;
    }

    const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (defMatch) {
      const fnDecorators = pendingIndent === indent ? pending : [];
      pending = [];
      pendingIndent = null;
      const kept = classStack.filter(
        (cls) => cls.indent.length < indent.length
      );
      classStack.length = 0;
      classStack.push(...kept);
      const cls = kept.length > 0 ? kept[kept.length - 1] : null;
      records.push({
        name: defMatch[1],
        defLine: i,
        indent,
        decorators: fnDecorators,
        className: cls ? cls.name : null,
        classLine: cls ? cls.line : null,
        classDecorators: cls ? cls.decorators : [],
      });
      i++;
      continue;
    }

    pending = [];
    pendingIndent = null;
    const kept = classStack.filter((cls) => indent.length > cls.indent.length);
    classStack.length = 0;
    classStack.push(...kept);
    i++;
  }
  return records;
}

function baseName(qualified: string): string {
  const parts = qualified.split(".");
  return parts[parts.length - 1] ?? qualified;
}

function isUnconditionalSkip(qualified: string): boolean {
  if (
    qualified === "unittest.skip" ||
    qualified === "pytest.mark.skip" ||
    qualified === "skip"
  ) {
    return true;
  }
  return false;
}

function isForbiddenHelper(qualified: string): boolean {
  const base = baseName(qualified);
  const lower = qualified.toLowerCase();
  if (
    base === "skipIf" ||
    base === "skipUnless" ||
    lower === "pytest.mark.skipif" ||
    lower.endsWith(".skipif")
  ) {
    return true;
  }
  if (/requires/i.test(base)) {
    return true;
  }
  if (lower.includes("onlycuda")) {
    return true;
  }
  if (/version/i.test(base)) {
    return true;
  }
  return false;
}

function isKnownBugHelper(qualified: string): boolean {
  if (isForbiddenHelper(qualified) || isUnconditionalSkip(qualified)) {
    return false;
  }
  const base = baseName(qualified);
  return /^skip[A-Z_]/.test(base) || /^skipIf/.test(base);
}

function extractStringLiterals(text: string): string[] {
  const literals: string[] = [];
  const pattern =
    /"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    literals.push(raw.replace(/\\(["'\\])/g, "$1"));
  }
  return literals;
}

function literalMatchesReason(
  codeSkip: string,
  literal: string,
  helperBase: string | null
): boolean {
  if (literal.length === 0) {
    return false;
  }
  if (codeSkip === literal) {
    return true;
  }
  if (helperBase && codeSkip === `${helperBase}: ${literal}`) {
    return true;
  }
  return false;
}

function decoratorMatches(block: DecoratorBlock, codeSkip: string): boolean {
  if (block.unclosed || block.name === "") {
    return false;
  }
  if (isForbiddenHelper(block.name)) {
    return false;
  }
  const literals = extractStringLiterals(block.text);
  if (isUnconditionalSkip(block.name)) {
    return literals.some((literal) =>
      literalMatchesReason(codeSkip, literal, null)
    );
  }
  if (!isKnownBugHelper(block.name) || !reasonIsKnownBug(codeSkip)) {
    return false;
  }
  const helper = baseName(block.name);
  if (!codeSkip.toLowerCase().includes(helper.toLowerCase())) {
    return false;
  }
  if (literals.length === 0) {
    const prefix = `${helper}: `;
    if (!codeSkip.startsWith(prefix)) {
      return false;
    }
    const message = codeSkip.slice(prefix.length);
    return (
      /does(?:n't| not) currently work/i.test(message) &&
      !reasonIsCapabilitySkip(message)
    );
  }
  return literals.some((literal) =>
    literalMatchesReason(codeSkip, literal, helper)
  );
}

function forbiddenButPresent(
  blocks: DecoratorBlock[],
  codeSkip: string
): boolean {
  return blocks.some((block) => {
    if (!isForbiddenHelper(block.name)) {
      return false;
    }
    const helper = baseName(block.name);
    return extractStringLiterals(block.text).some(
      (literal) =>
        literalMatchesReason(codeSkip, literal, null) ||
        literalMatchesReason(codeSkip, literal, helper) ||
        codeSkip.includes(literal)
    );
  });
}

export function removeCodeSkipDecorator(
  source: string,
  testName: string,
  classname: string,
  codeSkip: string
): { ok: true; source: string } | { ok: false; reason: string } {
  if (reasonIsCapabilitySkip(codeSkip)) {
    return {
      ok: false,
      reason:
        "stored reason matches a capability skip (PTX, CUDA-specific, hipBLAS, or NVIDIA-only)",
    };
  }
  const className = testClassName(classname);
  const records = indexFunctions(source);
  const matches = records.filter(
    (record) =>
      record.name === testName &&
      (className === null || record.className === className)
  );
  if (matches.length === 0) {
    return { ok: false, reason: "could not find the test function" };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "multiple functions match this test; not editing",
    };
  }
  const record = matches[0];
  const functionHits = record.decorators.filter((block) =>
    decoratorMatches(block, codeSkip)
  );
  if (functionHits.length > 1) {
    return {
      ok: false,
      reason: "multiple decorators match this code skip; not editing",
    };
  }
  let span: DecoratorBlock | null = null;
  if (functionHits.length === 1) {
    span = functionHits[0];
  } else if (forbiddenButPresent(record.decorators, codeSkip)) {
    return {
      ok: false,
      reason:
        "decorator is skipIf, skipUnless, requires_*, onlyCUDA, or a version-floor helper",
    };
  } else {
    const classHits = record.classDecorators.filter((block) =>
      decoratorMatches(block, codeSkip)
    );
    if (classHits.length > 1) {
      return {
        ok: false,
        reason: "multiple class decorators match this code skip; not editing",
      };
    }
    if (classHits.length === 1) {
      const siblings = records.filter(
        (other) =>
          other.classLine === record.classLine &&
          other.className === record.className &&
          other.name.startsWith("test")
      );
      if (siblings.length !== 1) {
        return {
          ok: false,
          reason: "class-level skip covers other tests; not editing",
        };
      }
      span = classHits[0];
    }
  }
  if (span === null) {
    return {
      ok: false,
      reason: "could not isolate one matching decorator",
    };
  }
  if (reasonIsCapabilitySkip(span.text)) {
    return {
      ok: false,
      reason:
        "decorator text matches a capability skip (PTX, CUDA-specific, hipBLAS, or NVIDIA-only)",
    };
  }
  const { lines, newline, trailing } = splitSource(source);
  const kept = lines.filter((_, idx) => idx < span.start || idx > span.end);
  let updated = kept.join(newline);
  if (trailing) {
    updated += newline;
  }
  return { ok: true, source: updated };
}

function codeSkipOf(row: PassingCodeSkipRow): string | null {
  const reasons = Array.isArray(row.code_skips) ? row.code_skips : [];
  const unique = Array.from(new Set(reasons.map((reason) => reason.trim())));
  if (unique.length !== 1 || unique[0] === "") {
    return null;
  }
  return unique[0];
}

function rowKey(row: PassingCodeSkipRow): string {
  return `${row.filename}\0${row.classname}\0${row.name}`;
}

export function planCodeSkipEdits(
  rows: PassingCodeSkipRow[],
  sources: ReadonlyMap<string, string>
): CodeSkipPlan {
  const removed: PassingCodeSkipRow[] = [];
  const omitted: OmittedCodeSkip[] = [];
  const editsByPath = new Map<string, string>();

  const ordered = [...rows].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
  // Apply later functions first so earlier line numbers stay valid. Grouped
  // below by path, then by def line descending inside remove passes.
  const pendingByPath = new Map<
    string,
    { row: PassingCodeSkipRow; codeSkip: string }[]
  >();

  for (const row of ordered) {
    const codeSkip = codeSkipOf(row);
    if (codeSkip === null) {
      omitted.push({
        row,
        reason:
          "more than one code_skip reason in the window, or the reason is empty",
      });
      continue;
    }
    if (reasonIsCapabilitySkip(codeSkip)) {
      omitted.push({
        row,
        reason:
          "stored reason matches a capability skip (PTX, CUDA-specific, hipBLAS, or NVIDIA-only)",
      });
      continue;
    }
    const path = repoPathForTestFile(row.filename);
    const list = pendingByPath.get(path) ?? [];
    list.push({ row, codeSkip });
    pendingByPath.set(path, list);
  }

  for (const [path, pending] of pendingByPath) {
    const source = sources.get(path);
    if (source === undefined) {
      for (const item of pending) {
        omitted.push({ row: item.row, reason: "source file not found" });
      }
      continue;
    }
    // Remove from the bottom of the file upward. The editor searches by
    // function name, so this only keeps two edits in one file from colliding.
    const located = pending
      .map((item) => {
        const className = testClassName(item.row.classname);
        const record = indexFunctions(source).find(
          (fn) =>
            fn.name === item.row.name &&
            (className === null || fn.className === className)
        );
        return { item, defLine: record ? record.defLine : -1 };
      })
      .sort((a, b) => b.defLine - a.defLine);

    let current = source;
    const applied: PassingCodeSkipRow[] = [];
    for (const { item } of located) {
      const result = removeCodeSkipDecorator(
        current,
        item.row.name,
        item.row.classname,
        item.codeSkip
      );
      if (!result.ok) {
        omitted.push({ row: item.row, reason: result.reason });
        continue;
      }
      current = result.source;
      applied.push(item.row);
    }
    if (applied.length > 0 && current !== source) {
      editsByPath.set(path, current);
      removed.push(...applied);
    }
  }

  const files = Array.from(editsByPath.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, content]) => ({ path, content }));

  removed.sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
  omitted.sort((a, b) => rowKey(a.row).localeCompare(rowKey(b.row)));
  return { removed, omitted, files };
}

function formatTest(row: PassingCodeSkipRow): string {
  return `\`${row.name}\` in \`${row.classname}\` (\`${repoPathForTestFile(
    row.filename
  )}\`)`;
}

function formatReason(row: PassingCodeSkipRow): string {
  const reason = codeSkipOf(row);
  if (reason === null) {
    return Array.isArray(row.code_skips) ? row.code_skips.join(" | ") : "";
  }
  return reason;
}

export function buildPullRequestBody(plan: CodeSkipPlan): string {
  const removedLines = plan.removed.map(
    (row) =>
      `- ${formatTest(row)}: \`${formatReason(row)}\`. greens=${
        row.num_green
      }, reds=${row.num_red}.`
  );
  const omittedLines = plan.omitted.map(
    (item) =>
      `- ${formatTest(item.row)}: ${item.reason}. reason=\`${formatReason(
        item.row
      )}\`. greens=${item.row.num_green}, reds=${item.row.num_red}.`
  );
  const sections = [
    "This draft removes code-skip decorators that passed the rerun-disabled-tests bar. A human must review it before merge. This bot does not merge the pull request.",
    "",
    `The bar is the same one that closes a DISABLED issue: the last ${CODE_SKIP_WINDOW_DAYS} days, at least ${CODE_SKIP_MIN_GREEN} greens, zero reds, and no failing row in that window.`,
    "",
    "Capability skips (PTX, CUDA-specific, hipBLAS, NVIDIA-only) stay in the source. A decorator that cannot be isolated to this one test stays too.",
    "",
    "## Removed",
    "",
    removedLines.join("\n"),
  ];
  if (omittedLines.length > 0) {
    sections.push("", "## Left in place", "", omittedLines.join("\n"));
  }
  return sections.join("\n") + "\n";
}

function decodeGitHubFile(data: {
  content?: string;
  encoding?: string;
  type?: string;
}): string | null {
  if (data.type === "dir" || data.content === undefined) {
    return null;
  }
  if (data.encoding === "base64") {
    return Buffer.from(data.content.replace(/\s/g, ""), "base64").toString(
      "utf8"
    );
  }
  return data.content;
}

async function readRepoFile(
  octokit: Octokit,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner: PYTORCH,
      repo: PYTORCH,
      path,
      ref,
    });
    if (Array.isArray(response.data)) {
      return null;
    }
    return decodeGitHubFile(response.data);
  } catch (err) {
    console.log(`Could not read ${path} at ${ref}: ${err}`);
    return null;
  }
}

interface OpenBatch {
  number: number;
  body: string;
  headRef: string;
  headSha: string;
}

async function findOpenBatch(octokit: Octokit): Promise<OpenBatch | null> {
  const query = `repo:${PYTORCH}/${PYTORCH} is:pr is:open in:title "${CODE_SKIP_UNSKIP_PR_TITLE}"`;
  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: query,
    per_page: 10,
  });
  const hit = data.items.find(
    (item) => item.title === CODE_SKIP_UNSKIP_PR_TITLE
  );
  if (!hit) {
    return null;
  }
  const pr = await octokit.rest.pulls.get({
    owner: PYTORCH,
    repo: PYTORCH,
    pull_number: hit.number,
  });
  if (pr.data.head.repo?.full_name !== `${PYTORCH}/${PYTORCH}`) {
    console.log(
      `Open batch PR #${pr.data.number} is not pushed to ${PYTORCH}/${PYTORCH}; not opening a second one.`
    );
    return {
      number: pr.data.number,
      body: pr.data.body ?? "",
      headRef: "",
      headSha: "",
    };
  }
  return {
    number: pr.data.number,
    body: pr.data.body ?? "",
    headRef: pr.data.head.ref,
    headSha: pr.data.head.sha,
  };
}

async function filesMatchHead(
  octokit: Octokit,
  existing: OpenBatch,
  files: FileEdit[]
): Promise<boolean> {
  if (existing.headSha === "") {
    return false;
  }
  for (const file of files) {
    const current = await readRepoFile(octokit, file.path, existing.headSha);
    if (current !== file.content) {
      return false;
    }
  }
  const desired = new Set(files.map((file) => file.path));
  for (let page = 1; page <= 5; page++) {
    const listed = await octokit.rest.pulls.listFiles({
      owner: PYTORCH,
      repo: PYTORCH,
      pull_number: existing.number,
      per_page: 100,
      page,
    });
    for (const changed of listed.data) {
      if (!desired.has(changed.filename)) {
        return false;
      }
    }
    if (listed.data.length < 100) {
      break;
    }
  }
  return true;
}

function batchCommitMessage(removedCount: number): string {
  return [
    "Unskip code skips that passed rerun-disabled-tests",
    "",
    `Remove ${removedCount} code-skip decorator(s) that passed the same bar used to close DISABLED issues (${CODE_SKIP_WINDOW_DAYS} days, at least ${CODE_SKIP_MIN_GREEN} greens, 0 reds).`,
    "A human should review this draft before merge.",
  ].join("\n");
}

async function commitOntoMain(
  octokit: Octokit,
  files: FileEdit[],
  removedCount: number
): Promise<string> {
  const mainRef = await octokit.rest.git.getRef({
    owner: PYTORCH,
    repo: PYTORCH,
    ref: "heads/main",
  });
  const mainSha = mainRef.data.object.sha;
  const mainCommit = await octokit.rest.git.getCommit({
    owner: PYTORCH,
    repo: PYTORCH,
    commit_sha: mainSha,
  });
  const tree = [];
  for (const file of files) {
    const blob = await octokit.rest.git.createBlob({
      owner: PYTORCH,
      repo: PYTORCH,
      content: file.content,
      encoding: "utf-8",
    });
    tree.push({
      path: file.path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: blob.data.sha,
    });
  }
  const nextTree = await octokit.rest.git.createTree({
    owner: PYTORCH,
    repo: PYTORCH,
    base_tree: mainCommit.data.tree.sha,
    tree,
  });
  const commit = await octokit.rest.git.createCommit({
    owner: PYTORCH,
    repo: PYTORCH,
    message: batchCommitMessage(removedCount),
    tree: nextTree.data.sha,
    parents: [mainSha],
  });
  return commit.data.sha;
}

async function moveBranch(
  octokit: Octokit,
  branch: string,
  sha: string,
  create: boolean
): Promise<void> {
  if (!create) {
    await octokit.rest.git.updateRef({
      owner: PYTORCH,
      repo: PYTORCH,
      ref: `heads/${branch}`,
      sha,
      force: true,
    });
    return;
  }
  try {
    await octokit.rest.git.createRef({
      owner: PYTORCH,
      repo: PYTORCH,
      ref: `refs/heads/${branch}`,
      sha,
    });
  } catch (err) {
    console.log(`Branch ${branch} already exists; updating it. ${err}`);
    await octokit.rest.git.updateRef({
      owner: PYTORCH,
      repo: PYTORCH,
      ref: `heads/${branch}`,
      sha,
      force: true,
    });
  }
}

export async function handlePassingCodeSkips(
  octokit: Octokit,
  rows: PassingCodeSkipRow[]
): Promise<void> {
  try {
    await openOrUpdateCodeSkipPullRequest(octokit, rows);
  } catch (err) {
    console.warn(`code-skip unskip step failed: ${err}`);
  }
}

async function openOrUpdateCodeSkipPullRequest(
  octokit: Octokit,
  rows: PassingCodeSkipRow[]
): Promise<void> {
  if (rows.length === 0) {
    console.log(
      "No code skips cleared the rerun bar; not opening a pull request."
    );
    return;
  }

  const neededPaths = new Set<string>();
  for (const row of rows) {
    const reason = codeSkipOf(row);
    if (reason !== null && !reasonIsCapabilitySkip(reason)) {
      neededPaths.add(repoPathForTestFile(row.filename));
    }
  }
  const sources = new Map<string, string>();
  for (const path of neededPaths) {
    const text = await readRepoFile(octokit, path, "main");
    if (text !== null) {
      sources.set(path, text);
    }
  }

  const plan = planCodeSkipEdits(rows, sources);
  for (const item of plan.omitted) {
    console.log(
      `Leaving ${item.row.name} (${item.row.classname}) in place: ${item.reason}`
    );
  }
  if (plan.removed.length === 0) {
    console.log(
      "Code skips cleared the bar but none could be edited safely; not opening a pull request."
    );
    return;
  }

  const body = buildPullRequestBody(plan);
  const existing = await findOpenBatch(octokit);
  if (existing && existing.headRef === "") {
    return;
  }
  if (existing) {
    const sameFiles = await filesMatchHead(octokit, existing, plan.files);
    if (sameFiles && existing.body === body) {
      console.log(
        `Batch pull request #${existing.number} already matches this set.`
      );
      return;
    }
    if (!sameFiles) {
      const sha = await commitOntoMain(
        octokit,
        plan.files,
        plan.removed.length
      );
      await moveBranch(octokit, existing.headRef, sha, false);
    }
    if (existing.body !== body) {
      await octokit.rest.pulls.update({
        owner: PYTORCH,
        repo: PYTORCH,
        pull_number: existing.number,
        body,
      });
    }
    console.log(`Updated batch pull request #${existing.number}.`);
    return;
  }

  const sha = await commitOntoMain(octokit, plan.files, plan.removed.length);
  await moveBranch(octokit, CODE_SKIP_UNSKIP_BRANCH, sha, true);
  const created = await octokit.rest.pulls.create({
    owner: PYTORCH,
    repo: PYTORCH,
    title: CODE_SKIP_UNSKIP_PR_TITLE,
    head: CODE_SKIP_UNSKIP_BRANCH,
    base: "main",
    body,
    draft: true,
  });
  console.log(
    `Opened draft pull request #${created.data.number} for ${plan.removed.length} code skip(s).`
  );
}

export const __forTesting__ = {
  indexFunctions,
  decoratorMatches,
  codeSkipOf,
};

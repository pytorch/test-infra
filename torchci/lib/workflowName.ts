// A workflow is known by its file: .github/workflows/pull.yml is "pull.yml".
// Every workflow in the repository lives in that directory, so the directory
// says nothing; a path of another shape is kept whole. The tests page names
// the workflows in its cells by this rule and GET /api/tests/options labels
// the values it offers by it, so the two cannot disagree. Nothing is imported
// here: the page keeps server code out of its bundle by importing only types
// from lib/api, and this module serves both sides.
export function workflowName(path: string): string {
  const match = /^\.github\/workflows\/(.+)$/.exec(path);
  return match === null ? path : match[1];
}

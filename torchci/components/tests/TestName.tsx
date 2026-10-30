import { Box } from "@mui/material";
import TextButton from "components/tests/TextButton";
import TextLink from "components/tests/TextLink";
import type { TestRecord } from "lib/api/tests/types";
import { Fragment } from "react";

export type TestNameParts = Pick<TestRecord, "file" | "suite" | "case_name">;

export const TEST_NAME_SEPARATOR = "::";

// The parts of a test's name that are set, in pytest node id order: the file,
// the suite unless the test is a module-level function, then the case.
export function testNameParts(test: TestNameParts): string[] {
  return [test.file, test.suite, test.case_name].filter((part) => part !== "");
}

// A part of a name in the pieces a line may break between: each but the last
// ends with the "_" or "/" that a path or a test name is read by, so
// "test/test_torch.py" is "test/", "test_", "torch.py". A browser finds no
// break of its own in either.
export function breakPieces(part: string): string[] {
  return part.match(/[^_/]*[_/]|[^_/]+$/g) ?? [];
}

// A part set so a line may break after any "_" or "/" in it: a break
// opportunity (<wbr>) between its pieces, which keeps a wrapped name reading
// as its pieces rather than breaking mid-word. The title of a test's page
// (TestTitle) sets its case name the same way.
export function Breakable({ text }: { text: string }) {
  return (
    <>
      {breakPieces(text).map((piece, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {piece}
        </Fragment>
      ))}
    </>
  );
}

export interface TestNameProps {
  test: TestNameParts;
  // Given, the case name is a link there: the test's own page.
  href?: string;
  // Given, the file and the suite are searches: a click searches for that
  // text, as the Name header's field would.
  onSearch?: (_text: string) => void;
}

// A test's name in two lines and two voices, like the cells beside it: the
// case name full strength, since it is the test; beneath it, muted and
// smaller, the file and suite leading up to it, "test/test_torch.py ::
// TestTorch", with the separators more muted still. The case name is the
// way in to the test's page (TextLink, a real link, underlined at full
// strength when hovered), as the name is the way in on any list of things;
// the file and the suite beneath it search the list instead, underlining
// in the grey of the text that filters. Nothing is cut off: a
// line too long for the column wraps and the row grows to hold it. The case
// name wraps at a "_" or "/" in it, anywhere in a piece only when no joint
// fits; the line beneath wraps after a separator, and a file or suite longer
// than the line (114 of 673K files on 2026-10-26, no suite) anywhere. The
// file and the suite are each one text node: Chrome cannot start a drag
// selection in an inline element with several children (text and <wbr>
// alike) that sits at a half-pixel offset, which a centered page column
// gives every other window width, and a name is above all to be copied.
// The tooltip has the whole node id, to copy too.
export default function TestName({ test, href, onSearch }: TestNameProps) {
  const parts = testNameParts(test);
  const headline = parts[parts.length - 1] ?? "";
  const subtitle = parts.slice(0, -1);
  const name = <Breakable text={headline} />;
  return (
    <Box
      component="span"
      title={parts.join(TEST_NAME_SEPARATOR)}
      sx={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "flex-start",
        minWidth: 0,
        maxWidth: "100%",
        lineHeight: 1.25,
        overflowWrap: "anywhere",
      }}
    >
      <Box
        component="span"
        sx={{
          display: "block",
          maxWidth: "100%",
          color: "text.primary",
        }}
      >
        {href === undefined ? name : <TextLink href={href}>{name}</TextLink>}
      </Box>
      {subtitle.length > 0 && (
        <Box
          component="span"
          sx={{
            display: "block",
            maxWidth: "100%",
            fontSize: (theme) => theme.typography.caption.fontSize,
            color: "text.secondary",
          }}
        >
          {subtitle.map((part, index) => (
            <Fragment key={index}>
              {index > 0 && (
                <>
                  <Box
                    component="span"
                    sx={{ color: "text.disabled", mx: 0.5 }}
                  >
                    {TEST_NAME_SEPARATOR}
                  </Box>
                  {/* A line breaks after a separator, never before one. */}
                  <wbr />
                </>
              )}
              {onSearch === undefined ? (
                part
              ) : (
                <TextButton
                  label={`Search for ${part}`}
                  onClick={() => onSearch(part)}
                  wrap
                >
                  {part}
                </TextButton>
              )}
            </Fragment>
          ))}
        </Box>
      )}
    </Box>
  );
}

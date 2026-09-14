// A parsed verdict outline as a bullet list: topics emphasised, details nested
// one level under them, code spans in a monospace face.
//
// Every leaf reaches the DOM as a React text node, which is what contains the
// model's text here -- see the ban in GreenLightSection.tsx, which governs this
// file too. Nothing below escapes, guards or defuses anything, and that is
// correct: those defences answer GitHub's markdown pipeline, and on this surface
// they would only show the reader entities and split the shas they copy out.

import { Box, Typography } from "@mui/material";
import {
  OUTLINE_TRUNCATED_LABEL,
  OutlineSegment,
  ParsedOutline,
} from "lib/greenlight/greenlightOutline";
import { Fragment, ReactNode } from "react";

// A leaf is one unbroken line that the parser lets run to OUTLINE_LEAF_CAP with
// no space in it, and a list item offers no break opportunity of its own.
const LIST_SX = { m: 0, pl: 3, overflowWrap: "anywhere" } as const;

// The global bare-`code` rule paints --code-bg, which in dark mode is the same
// #2a2a2a the panel's Paper is forced to. A palette token is what keeps the chip
// legible on whichever background the mode gives it.
const CODE_SX = { bgcolor: "action.hover" } as const;

// An empty segment is always a text one: the parser splits on maximal backtick
// runs, so only a leaf's first and last part can be empty and both of those are
// text. Skipping them can therefore never drop a code span.
function segmentNodes(segments: OutlineSegment[]): ReactNode[] {
  return segments.flatMap(({ text, code }, index) => {
    if (text === "") {
      return [];
    }
    return [
      code ? (
        <Box component="code" key={index} sx={CODE_SX}>
          {text}
        </Box>
      ) : (
        <Fragment key={index}>{text}</Fragment>
      ),
    ];
  });
}

function DetailItem({ children }: { children: ReactNode }) {
  return (
    <Typography component="li" variant="body2" color="text.secondary">
      {children}
    </Typography>
  );
}

// The marker a clamp leaves behind, styled apart from every detail so that a
// leaf the model wrote reading "(truncated)" cannot pass for one: the model
// authors text, never a presentation. This holds on the panel and nowhere else.
// On the comment surfaces the marker is a plain <li> that a forged detail
// matches exactly, and nothing here closes that.
function TruncatedItem() {
  return (
    <Typography
      component="li"
      variant="body2"
      color="text.disabled"
      fontStyle="italic"
    >
      {OUTLINE_TRUNCATED_LABEL}
    </Typography>
  );
}

export default function GreenLightOutline({
  outline,
}: {
  outline: ParsedOutline;
}) {
  return (
    <Box component="ul" sx={LIST_SX}>
      {outline.topics.map((topic, index) => (
        <Typography
          key={index}
          component="li"
          variant="body2"
          color="text.primary"
        >
          <strong>{segmentNodes(topic.text)}</strong>
          {topic.details.length > 0 && (
            <Box component="ul" sx={LIST_SX}>
              {topic.details.map((detail, detailIndex) => (
                <DetailItem key={detailIndex}>
                  {segmentNodes(detail)}
                </DetailItem>
              ))}
              {topic.detailsTruncated && <TruncatedItem />}
            </Box>
          )}
        </Typography>
      ))}
      {outline.truncated && <TruncatedItem />}
    </Box>
  );
}

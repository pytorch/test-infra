import FilterAltIcon from "@mui/icons-material/FilterAlt";
import FilterAltOutlinedIcon from "@mui/icons-material/FilterAltOutlined";
import { Box, IconButton, Tooltip, useTheme } from "@mui/material";
import FacetMenu, { FacetSection } from "components/tests/FacetMenu";
import type { FacetValues } from "lib/tests/facets";
import {
  headerKeyColors,
  headerKeyFocusRing,
  headerKeySx,
} from "lib/tests/headerColors";
import { KeyboardEvent, MouseEvent, useId, useState } from "react";

export interface HeaderFilterProps {
  // The column, lowercase, for what the control says: "environment".
  column: string;
  // What is chosen, as the tooltip says it; empty when nothing is.
  summary: string;
  // The menu's first item: "Any environment".
  anyLabel: string;
  sections: readonly FacetSection[];
  value: FacetValues;
  onChange: (_next: Partial<FacetValues>) => void;
}

// The key's side, in pixels: the funnel with its padding and edge. The
// header leaves this much room, plus a gap, at its right.
export const HEADER_FILTER_SIZE = 26;
// How far the key sits in from the header's right edge, in pixels.
export const HEADER_FILTER_INSET = 6;

// A column's filter, in its header: a small key at the header's right edge
// that opens the column's facet menu. The key is a rounded square in the
// page's background color with a ruled edge, so it stands off the grey band
// as a control in either mode, and holds an outlined funnel in the text's
// own color while nothing is chosen. While something is, the key is filled
// in the accent color with a solid funnel, and the choice is its tooltip.
// Neither clicking it nor pressing a key on it sorts the column.
export default function HeaderFilter({
  column,
  summary,
  anyLabel,
  sections,
  value,
  onChange,
}: HeaderFilterProps) {
  const theme = useTheme();
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const active = summary !== "";
  const open = anchor !== null;
  const description = active
    ? `Filtering ${column} by ${summary}`
    : `Filter ${column}`;
  const Icon = active ? FilterAltIcon : FilterAltOutlinedIcon;
  // The key's colors by state: filled while something is chosen; on the
  // page's background otherwise, edged in the accent while its menu is open
  // and in the band's rule color at rest (headerKeyColors).
  const key = headerKeyColors(theme, { active, open });
  return (
    <Box
      component="span"
      sx={{
        position: "absolute",
        right: HEADER_FILTER_INSET,
        top: "50%",
        transform: "translateY(-50%)",
        display: "inline-flex",
      }}
    >
      <Tooltip title={description} enterDelay={400}>
        <IconButton
          size="small"
          aria-label={description}
          aria-haspopup="menu"
          aria-controls={open ? menuId : undefined}
          aria-expanded={open}
          onClick={(event: MouseEvent<HTMLElement>) => {
            // The header around it sorts on click.
            event.stopPropagation();
            setAnchor(event.currentTarget);
          }}
          // What is typed on the key stays on it, as in the Name header's
          // search field: the header around it sorts on Enter and moves
          // focus on the arrow keys, and must see none of the key's keys.
          onKeyDown={(event: KeyboardEvent<HTMLElement>) =>
            event.stopPropagation()
          }
          sx={{
            width: HEADER_FILTER_SIZE,
            height: HEADER_FILTER_SIZE,
            p: 0,
            // The button's own hover would wash the key with a translucent
            // grey and let the band through; the keys' frame stays opaque.
            ...headerKeySx(theme, key),
            "&.Mui-focusVisible": headerKeyFocusRing(theme),
          }}
        >
          <Icon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
      <FacetMenu
        id={menuId}
        anchor={anchor}
        onClose={() => setAnchor(null)}
        anyLabel={anyLabel}
        sections={sections}
        value={value}
        onChange={onChange}
      />
    </Box>
  );
}

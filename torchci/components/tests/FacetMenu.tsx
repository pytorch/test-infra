import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Box,
  Divider,
  ListItemText,
  Menu,
  menuClasses,
  MenuItem,
  Tooltip,
} from "@mui/material";
import CheckMenuItem from "components/tests/CheckMenuItem";
import {
  type FacetValues,
  labelOf,
  sectionSummary,
  type TestsFacet,
} from "lib/tests/facets";
import { Fragment, MutableRefObject, useEffect, useRef, useState } from "react";

export interface FacetSection {
  facet: TestsFacet;
  // The row that names the section when the menu has more than one.
  title: string;
  options: readonly { value: string; label: string }[];
}

export interface FacetMenuProps {
  id: string;
  // The element the menu hangs from; null while closed.
  anchor: HTMLElement | null;
  onClose: () => void;
  // The first item, which stands for no choice and clears every section:
  // "Any environment".
  anyLabel: string;
  sections: readonly FacetSection[];
  // The chosen values; only the sections' facets are read.
  value: FacetValues;
  // The sections' facets with their new values, in the order chosen.
  onChange: (_next: Partial<FacetValues>) => void;
}

// The menu's width in pixels: wider when it holds section rows, which say
// the facet and its choice on one line, "Test config  inductor_cpp_wrapper".
const MENU_WIDTH = 240;
const FOLDED_MENU_WIDTH = 320;

interface ValueItemsProps {
  section: FacetSection;
  chosen: readonly string[];
  onToggle: (_facet: TestsFacet, _value: string) => void;
  // Set in under a section row, so the values read as its own.
  indented?: boolean;
  // Given the last item, for whoever needs to know where the section ends.
  lastRef?: MutableRefObject<HTMLLIElement | null>;
}

// A section's values, each a checkbox item (CheckMenuItem, which the title's
// menus share). They are direct children of the menu's list, as the arrow
// keys only reach those.
function ValueItems({
  section,
  chosen,
  onToggle,
  indented = false,
  lastRef,
}: ValueItemsProps) {
  const last = section.options.length - 1;
  return (
    <>
      {section.options.map((option, index) => (
        <CheckMenuItem
          key={option.value}
          ref={index === last ? lastRef : undefined}
          checked={chosen.includes(option.value)}
          label={option.label}
          dense
          indented={indented}
          onClick={() => onToggle(section.facet, option.value)}
        />
      ))}
    </>
  );
}

interface SectionSummaryProps {
  chosen: readonly string[];
  options: readonly { value: string; label: string }[];
}

// What a section row says of its facet, at the row's right: "Any", muted,
// while nothing is chosen; the one chosen value; or how many are chosen,
// listing them on hover. Long words wrap rather than run past the row.
function SectionSummary({ chosen, options }: SectionSummaryProps) {
  const summary = (
    <Box
      component="span"
      sx={{
        flex: 1,
        minWidth: 0,
        textAlign: "right",
        whiteSpace: "normal",
        overflowWrap: "anywhere",
        color: chosen.length === 0 ? "text.secondary" : "text.primary",
      }}
    >
      {sectionSummary(chosen, options)}
    </Box>
  );
  if (chosen.length < 2) {
    return summary;
  }
  return (
    <Tooltip
      title={chosen.map((value) => labelOf(value, options)).join("\n")}
      enterDelay={300}
      placement="top"
      slotProps={{ tooltip: { sx: { whiteSpace: "pre-line" } } }}
    >
      {summary}
    </Tooltip>
  );
}

interface FoldedSectionsProps {
  sections: readonly FacetSection[];
  value: FacetValues;
  onToggle: (_facet: TestsFacet, _value: string) => void;
}

// The sections folded, one row each, naming the facet and saying what is
// chosen, so every facet is in view when the menu opens however long its
// lists. A click on a row unfolds its values beneath it and folds the row
// that was open; a click on the open row folds it. The menu drops its items
// as it closes, so every row is folded again when it opens.
function FoldedSections({ sections, value, onToggle }: FoldedSectionsProps) {
  const [unfolded, setUnfolded] = useState<TestsFacet | null>(null);
  const unfoldedRow = useRef<HTMLLIElement | null>(null);
  const lastValue = useRef<HTMLLIElement | null>(null);

  // Values that run past the menu's bottom bring their row to the top, where
  // they have the most room; values that fit leave the list where it is.
  useEffect(() => {
    const row = unfoldedRow.current;
    const last = lastValue.current;
    const scroller = row?.closest(`.${menuClasses.paper}`);
    if (
      unfolded === null ||
      row === null ||
      last === null ||
      !scroller ||
      typeof row.scrollIntoView !== "function"
    ) {
      return;
    }
    if (
      last.getBoundingClientRect().bottom >
      scroller.getBoundingClientRect().bottom
    ) {
      row.scrollIntoView({ block: "start" });
    }
  }, [unfolded]);

  return (
    <>
      {sections.map((section) => {
        const open = section.facet === unfolded;
        const chosen = value[section.facet];
        const Chevron = open ? ExpandMoreIcon : ChevronRightIcon;
        return (
          <Fragment key={section.facet}>
            <MenuItem
              ref={open ? unfoldedRow : undefined}
              dense
              aria-expanded={open}
              onClick={() => setUnfolded(open ? null : section.facet)}
              sx={{ gap: 1 }}
            >
              <Box component="span" sx={{ flexShrink: 0 }}>
                {section.title}
              </Box>
              <SectionSummary chosen={chosen} options={section.options} />
              <Chevron
                sx={{ fontSize: 20, color: "text.secondary", flexShrink: 0 }}
              />
            </MenuItem>
            {open && (
              <ValueItems
                section={section}
                chosen={chosen}
                onToggle={onToggle}
                indented
                lastRef={lastValue}
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

// Several facets chosen from one menu, so a reader can narrow by an
// accelerator and a device in one visit. With one section, its values follow
// the first item as checkboxes. With several, each section is a folded row
// (FoldedSections). The menu stays open until the reader is done; the first
// item clears the sections and closes it.
export default function FacetMenu({
  id,
  anchor,
  onClose,
  anyLabel,
  sections,
  value,
  onChange,
}: FacetMenuProps) {
  const nothingChosen = sections.every(
    (section) => value[section.facet].length === 0
  );
  const folded = sections.length > 1;
  const toggle = (facet: TestsFacet, chosen: string) => {
    const values = value[facet];
    onChange({
      [facet]: values.includes(chosen)
        ? values.filter((other) => other !== chosen)
        : [...values, chosen],
    });
  };
  const clear = () => {
    onChange(
      Object.fromEntries(sections.map((section) => [section.facet, []]))
    );
    onClose();
  };

  return (
    <Menu
      id={id}
      anchorEl={anchor}
      open={anchor !== null}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      transformOrigin={{ vertical: "top", horizontal: "right" }}
      slotProps={{
        paper: {
          sx: {
            mt: 0.5,
            minWidth: folded ? FOLDED_MENU_WIDTH : MENU_WIDTH,
            maxHeight: "min(70vh, 560px)",
          },
        },
      }}
    >
      <MenuItem
        role="menuitemradio"
        aria-checked={nothingChosen}
        selected={nothingChosen}
        onClick={clear}
      >
        <ListItemText primary={anyLabel} />
      </MenuItem>
      <Divider />
      {folded ? (
        <FoldedSections sections={sections} value={value} onToggle={toggle} />
      ) : (
        sections.map((section) => (
          <ValueItems
            key={section.facet}
            section={section}
            chosen={value[section.facet]}
            onToggle={toggle}
          />
        ))
      )}
    </Menu>
  );
}

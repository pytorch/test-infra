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
import { labelOf, sectionSummary, type TestsFacet } from "lib/tests/facets";
import { Fragment, MutableRefObject, useEffect, useRef, useState } from "react";

// A section is a facet of the tests, or whatever else a menu is keyed by:
// the commit page's Job filter has a section a workflow.
export interface FacetSection<Key extends string = TestsFacet> {
  facet: Key;
  // The row that names the section when the menu has more than one.
  title: string;
  options: readonly { value: string; label: string }[];
}

export interface FacetMenuProps<Key extends string = TestsFacet> {
  id: string;
  // The element the menu hangs from; null while closed.
  anchor: HTMLElement | null;
  onClose: () => void;
  // The first item, which stands for no choice and clears every section:
  // "Any environment".
  anyLabel: string;
  sections: readonly FacetSection<Key>[];
  // The chosen values; only the sections' facets are read.
  value: Readonly<Record<Key, readonly string[]>>;
  // The sections' facets with their new values, in the order chosen.
  onChange: (_next: Partial<Record<Key, string[]>>) => void;
  // The menu holds one choice: a value chosen is its section's only one,
  // and closes the menu.
  single?: boolean;
  // The menu's width in pixels where its labels are long, as job names are;
  // a longer label wraps.
  width?: number;
  // Whether the first item is the choice made, where the sections' values
  // do not say: the commit page's Job filter can hold a pick the menu does
  // not list, a job without tests.
  nothingChosen?: boolean;
}

// The menu's width in pixels: wider when it holds section rows, which say
// the facet and its choice on one line, "Test config  inductor_cpp_wrapper".
const MENU_WIDTH = 240;
const FOLDED_MENU_WIDTH = 320;

interface ValueItemsProps<Key extends string> {
  section: FacetSection<Key>;
  chosen: readonly string[];
  onToggle: (_facet: Key, _value: string) => void;
  single: boolean;
  // Set in under a section row, so the values read as its own.
  indented?: boolean;
  // Given the last item, for whoever needs to know where the section ends.
  lastRef?: MutableRefObject<HTMLLIElement | null>;
}

// A section's values, each a checkbox item (CheckMenuItem, which the menus
// of the page's choices share), or in a menu of one choice an item marked
// while chosen, as the menu's first item is. They are direct children of
// the menu's list, as the arrow keys only reach those.
function ValueItems<Key extends string>({
  section,
  chosen,
  onToggle,
  single,
  indented = false,
  lastRef,
}: ValueItemsProps<Key>) {
  const last = section.options.length - 1;
  return (
    <>
      {section.options.map((option, index) =>
        single ? (
          <MenuItem
            key={option.value}
            ref={index === last ? lastRef : undefined}
            role="menuitemradio"
            aria-checked={chosen.includes(option.value)}
            selected={chosen.includes(option.value)}
            dense
            onClick={() => onToggle(section.facet, option.value)}
            sx={{
              whiteSpace: "normal",
              overflowWrap: "anywhere",
              ...(indented ? { pl: 4 } : {}),
            }}
          >
            <ListItemText primary={option.label} />
          </MenuItem>
        ) : (
          <CheckMenuItem
            key={option.value}
            ref={index === last ? lastRef : undefined}
            checked={chosen.includes(option.value)}
            label={option.label}
            dense
            indented={indented}
            onClick={() => onToggle(section.facet, option.value)}
          />
        )
      )}
    </>
  );
}

interface SectionSummaryProps {
  chosen: readonly string[];
  options: readonly { value: string; label: string }[];
  single: boolean;
}

// What a section row says of its facet, at the row's right: "Any", muted,
// while nothing is chosen; the one chosen value; or how many are chosen,
// listing them on hover. Long words wrap rather than run past the row. A
// menu of one choice lists none: several are chosen there only by the
// timeline's pick, a build's jobs, and the row unfolded shows them.
function SectionSummary({ chosen, options, single }: SectionSummaryProps) {
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
  if (chosen.length < 2 || single) {
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

interface FoldedSectionsProps<Key extends string> {
  sections: readonly FacetSection<Key>[];
  value: Readonly<Record<Key, readonly string[]>>;
  onToggle: (_facet: Key, _value: string) => void;
  single: boolean;
}

// The sections folded, one row each, naming the facet and saying what is
// chosen, so every facet is in view when the menu opens however long its
// lists. A click on a row unfolds its values beneath it and folds the row
// that was open; a click on the open row folds it. The menu drops its items
// as it closes, so every row is folded again when it opens.
function FoldedSections<Key extends string>({
  sections,
  value,
  onToggle,
  single,
}: FoldedSectionsProps<Key>) {
  const [unfolded, setUnfolded] = useState<Key | null>(null);
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
              <SectionSummary
                chosen={chosen}
                options={section.options}
                single={single}
              />
              <Chevron
                sx={{ fontSize: 20, color: "text.secondary", flexShrink: 0 }}
              />
            </MenuItem>
            {open && (
              <ValueItems
                section={section}
                chosen={chosen}
                onToggle={onToggle}
                single={single}
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
// item clears the sections and closes it. A menu of one choice (`single`)
// closes on the choice.
export default function FacetMenu<Key extends string = TestsFacet>({
  id,
  anchor,
  onClose,
  anyLabel,
  sections,
  value,
  onChange,
  single = false,
  width,
  nothingChosen = sections.every(
    (section) => value[section.facet].length === 0
  ),
}: FacetMenuProps<Key>) {
  const folded = sections.length > 1;
  const change = (facet: Key, values: string[]) =>
    onChange({ [facet]: values } as Partial<Record<Key, string[]>>);
  const toggle = (facet: Key, chosen: string) => {
    if (single) {
      change(facet, [chosen]);
      onClose();
      return;
    }
    const values = value[facet];
    change(
      facet,
      values.includes(chosen)
        ? values.filter((other) => other !== chosen)
        : [...values, chosen]
    );
  };
  const clear = () => {
    onChange(
      Object.fromEntries(
        sections.map((section) => [section.facet, [] as string[]])
      ) as Partial<Record<Key, string[]>>
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
            ...(width === undefined
              ? { minWidth: folded ? FOLDED_MENU_WIDTH : MENU_WIDTH }
              : { width }),
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
        <FoldedSections
          sections={sections}
          value={value}
          onToggle={toggle}
          single={single}
        />
      ) : (
        sections.map((section) => (
          <ValueItems
            key={section.facet}
            section={section}
            chosen={value[section.facet]}
            onToggle={toggle}
            single={single}
          />
        ))
      )}
    </Menu>
  );
}

import {
  Button,
  Divider,
  ListSubheader,
  MenuItem,
  MenuList,
  Paper,
  Popper,
} from "@mui/material";
import { Box } from "@mui/system";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

export type NavItem = { label: string; route: string; type: "item" };
export type NavCategory = { label: string; items: NavItem[]; type: "group" };
export type NavDivider = { type: "divider" };

/**
 * NavBarGroupDropdown
 * it flats the group with single item in sorted order, then list
 * group in sorted order.
 * @returns
 */
export function NavBarGroupDropdown({
  title,
  items,
}: {
  title: string;
  items: (NavCategory | NavItem | NavDivider)[];
}) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);
  const boxRef = useRef<HTMLDivElement>(null);

  // Check if device is touch-enabled
  const isTouchDevice = useMemo(
    () =>
      typeof window !== "undefined" &&
      ("ontouchstart" in window || navigator.maxTouchPoints > 0),
    []
  );

  // Set dropdown state only on non-touch devices
  const setDropdownIfNotTouch = (value: HTMLElement | null) => {
    if (!isTouchDevice) {
      setAnchorEl(value);
    }
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (boxRef.current && !boxRef.current.contains(target)) {
        setAnchorEl(null);
      }
    };

    if (open) {
      document.addEventListener("click", handleClickOutside);
      return () => {
        document.removeEventListener("click", handleClickOutside);
      };
    }
  }, [open]);

  return (
    <Box
      ref={boxRef}
      onMouseEnter={(e) => setDropdownIfNotTouch(e.currentTarget)}
      onMouseLeave={() => setDropdownIfNotTouch(null)}
    >
      <Button
        id="grouped-menu-button"
        aria-controls={open ? "grouped-menu" : undefined}
        aria-haspopup="true"
        aria-expanded={open ? "true" : undefined}
        onClick={(e) => {
          if (isTouchDevice) {
            // Toggle dropdown on touch devices
            setAnchorEl(anchorEl ? null : e.currentTarget);
          }
        }}
        sx={{
          textTransform: "none",
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: "inherit",
          fontWeight: 400,
        }}
      >
        {title} ▾
      </Button>
      <Popper
        open={open}
        anchorEl={anchorEl}
        placement="bottom-start"
        disablePortal
      >
        <Paper>
          <MenuList>
            {/* Singles first (no headers), sorted by item label */}
            {items.map((item) => {
              if (item.type === "item")
                return (
                  <MenuItem
                    key={`single-${item.label}`}
                    component="a"
                    href={item.route}
                    sx={{
                      color: "primary.main",
                    }}
                  >
                    {item.label}
                  </MenuItem>
                );

              if (item.type === "group") {
                const group = item;
                return (
                  <Fragment key={`multi-${group.label}`}>
                    <ListSubheader
                      disableSticky
                      sx={{
                        bgcolor: "transparent",
                        fontSize: 13,
                        fontWeight: 800,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                        lineHeight: 2,
                      }}
                    >
                      {group.label}
                    </ListSubheader>
                    <Box
                      sx={{
                        borderLeft: "2px solid",
                        borderColor: "divider",
                        ml: 2,
                        pl: 1.5,
                      }}
                    >
                      {group.items.map((item) => (
                        <MenuItem
                          key={`${group.label}-${item.label}`}
                          component="a"
                          href={item.route}
                          sx={{
                            color: "primary.main",
                            pl: 1,
                          }}
                        >
                          {item.label}
                        </MenuItem>
                      ))}
                    </Box>
                  </Fragment>
                );
              }
              if (item.type === "divider") {
                return <Divider sx={{ mt: 1 }} />;
              }
            })}
          </MenuList>
        </Paper>
      </Popper>
    </Box>
  );
}

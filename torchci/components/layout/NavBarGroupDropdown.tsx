import { Button, Divider, ListSubheader, Menu, MenuItem } from "@mui/material";
import { Box } from "@mui/system";
import Link from "next/link";
import { Fragment, MouseEvent, useMemo, useState } from "react";

export type NavItem = { label: string; route: string };
export type NavCategory = { label: string; items: NavItem[]; type?: string };

function sortForMenu(groups: NavCategory[]) {
  const singles: NavItem[] = [];
  const multis: NavCategory[] = [];
  let bottom: NavItem | undefined = undefined;

  for (const g of groups) {
    if (g.type === "bottom") {
      if (g.items.length !== 1) {
        continue;
      }
      bottom = g?.items[0];
    } else if (g.items.length === 1) {
      singles.push(g.items[0]);
    } else if (g.items.length > 1) {
      multis.push({
        label: g.label,
        items: [...g.items].sort((a, b) => a.label.localeCompare(b.label)),
      });
    }
  }
  singles.sort((a, b) => a.label.localeCompare(b.label));
  multis.sort((a, b) => a.label.localeCompare(b.label));
  return { singles, multis, bottom };
}

/**
 * NavBarGroupDropdown
 * it flats the group with single item in sorted order, then list
 * group in sorted order.
 * @returns
 */
export function NavBarGroupDropdown({
  title,
  groups,
}: {
  title: string;
  groups: NavCategory[];
}) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const handleMouseEnter = (e: MouseEvent<HTMLButtonElement>) =>
    setAnchorEl(e.currentTarget);
  const handleMouseLeave = () => setAnchorEl(null);

  const { singles, multis, bottom } = useMemo(
    () => sortForMenu(groups),
    [groups]
  );

  return (
    <div onMouseLeave={handleMouseLeave}>
      <Button
        id="grouped-menu-button"
        aria-controls={open ? "grouped-menu" : undefined}
        aria-haspopup="true"
        aria-expanded={open ? "true" : undefined}
        onMouseEnter={handleMouseEnter}
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
      <Menu
        id="grouped-menu"
        autoFocus={false}
        anchorEl={anchorEl}
        open={open}
        onClose={handleMouseLeave}
        slotProps={{
          paper: {
            onMouseLeave: handleMouseLeave,
          },
          list: {
            "aria-labelledby": "grouped-menu-button",
            sx: {
              py: 0,
              "& .MuiMenuItem-root": { cursor: "pointer" },
              "& .MuiListSubheader-root": { cursor: "default" },
            },
          },
        }}
      >
        {/* Singles first (no headers), sorted by item label */}
        {singles.map((item) => (
          <MenuItem
            key={`single-${item.label}`}
            component={Link as any}
            href={item.route}
            prefetch={false}
            onClick={handleMouseLeave}
            sx={{
              color: "primary.main",
            }}
          >
            {item.label}
          </MenuItem>
        ))}

        {/* Multi-item groups next, sorted by group label; each group header + its sorted items */}
        {multis.map((group, gi) => (
          <Fragment key={`multi-${group.label}`}>
            <ListSubheader
              disableSticky
              sx={{
                bgcolor: "transparent",
                fontSize: 13,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: 0.5,
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
                  component={Link as any}
                  href={item.route}
                  prefetch={false}
                  onClick={handleMouseLeave}
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
        ))}
        {bottom != undefined && (
          <>
            <Divider sx={{ mt: 1 }} />
            <MenuItem
              key={`bottom-${bottom.label}`}
              component={Link as any}
              href={bottom.route}
              prefetch={false}
              onClick={handleMouseLeave}
              sx={{
                color: "primary.main",
              }}
            >
              {bottom.label}
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}

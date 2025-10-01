import { Button, Divider, ListSubheader, Menu, MenuItem } from "@mui/material";
import { benchmarkNavGroup } from "components/benchmark/v3/BenchmarkListPage";
import styles from "components/layout/NavBar.module.css";
import Link from "next/link";
import React, { useState } from "react";
import { AiFillGithub } from "react-icons/ai";
import ThemeModePicker from "../common/ThemeModePicker";
import LoginSection from "./LoginSection";

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
 * group in sorted order
 * @returns
 */
export function NavBarGroupDropdown({
  title,
  groups,
}: {
  title: string;
  groups: NavCategory[];
}) {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) =>
    setAnchorEl(e.currentTarget);
  const handleMouseLeaveAll = () => setAnchorEl(null);

  const { singles, multis, bottom } = React.useMemo(
    () => sortForMenu(groups),
    [groups]
  );

  return (
    <div onMouseLeave={handleMouseLeaveAll}>
      <Button
        id="grouped-menu-button"
        aria-controls={open ? "grouped-menu" : undefined}
        aria-haspopup="true"
        aria-expanded={open ? "true" : undefined}
        onMouseEnter={handleMouseEnter}
        sx={{ textTransform: "none", cursor: "pointer" }}
      >
        {title} ▾
      </Button>
      <Menu
        id="grouped-menu"
        autoFocus={false}
        anchorEl={anchorEl}
        open={open}
        onClose={handleMouseLeaveAll}
        slotProps={{
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
            onClick={handleMouseLeaveAll}
          >
            {item.label}
          </MenuItem>
        ))}

        {singles.length > 0 && multis.length > 0 && <Divider component="li" />}
        {/* Multi-item groups next, sorted by group label; each group header + its sorted items */}
        {multis.map((group, gi) => (
          <React.Fragment key={`multi-${group.label}`}>
            <ListSubheader disableSticky>{group.label}</ListSubheader>
            {group.items.map((item) => (
              <MenuItem
                key={`${group.label}-${item.label}`}
                component={Link as any}
                href={item.route}
                prefetch={false}
                onClick={handleMouseLeaveAll}
              >
                {item.label}
              </MenuItem>
            ))}

            {/* Divider between multi groups (but not after the last one) */}
            {gi < multis.length - 1 && <Divider component="li" />}
          </React.Fragment>
        ))}
        {bottom != undefined && (
          <>
            <Divider component="li" />
            <MenuItem
              key={`bottom-${bottom.label}`}
              component={Link as any}
              href={bottom.route}
              prefetch={false}
              onClick={handleMouseLeaveAll}
            >
              {bottom.label}
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}

const NavBarDropdown = ({
  title,
  items,
}: {
  title: string;
  items: any;
}): JSX.Element => {
  const [dropdown, setDropdown] = useState(false);
  const dropdownStyle = dropdown ? { display: "block" } : {};
  const firstItemHref = items.length > 0 ? items[0].href : "#";

  // Check if device is touch-enabled
  const isTouchDevice = React.useMemo(
    () =>
      typeof window !== "undefined" &&
      ("ontouchstart" in window || navigator.maxTouchPoints > 0),
    []
  );

  // Set dropdown state only on non-touch devices
  const setDropdownIfNotTouch = (value: boolean) => {
    if (!isTouchDevice) {
      setDropdown(value);
    }
  };

  // Close dropdown when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(`.${styles.dropdownContainer}`)) {
        setDropdown(false);
      }
    };

    if (dropdown) {
      document.addEventListener("click", handleClickOutside);
      return () => {
        document.removeEventListener("click", handleClickOutside);
      };
    }
  }, [dropdown]);

  return (
    <li
      onMouseEnter={() => setDropdownIfNotTouch(true)}
      onMouseLeave={() => setDropdownIfNotTouch(false)}
      style={{ padding: 0 }}
      className={`${styles.dropdownContainer} ${
        dropdown ? styles.dropdownOpen : ""
      }`}
    >
      <Link
        href={firstItemHref}
        prefetch={false}
        className={styles.dropdowntitle}
        onClick={(e) => {
          if (isTouchDevice) {
            // otherwise the menu will close immediately on touch devices
            e.preventDefault();
          }
          setDropdown(!dropdown);
        }}
      >
        {title} ▾
      </Link>
      <ul className={styles.dropdown} style={dropdownStyle}>
        {items.map((item: any) => (
          <li key={item.href}>
            <Link href={item.href} prefetch={false}>
              {item.name}
            </Link>
          </li>
        ))}
      </ul>
    </li>
  );
};

function NavBar() {
  const benchmarkDropdown = benchmarkNavGroup;

  const devInfraDropdown = [
    {
      name: "SLIs",
      href: "/sli",
    },
    {
      name: "TTS",
      href: "/tts",
    },
    {
      name: "Queue Time Analysis",
      href: "/queue_time_analysis",
    },
    {
      name: "Nightly Branch",
      href: "/hud/pytorch/pytorch/nightly",
    },
    {
      name: "Nightly Dashboard",
      href: "/nightlies",
    },
    {
      name: "Cancelled Jobs",
      href: "/job_cancellation_dashboard",
    },
    {
      name: "Failures Metric",
      href: "/reliability",
    },
    {
      name: "Failures Classifier",
      href: "/failedjobs/pytorch/pytorch/main",
    },

    {
      name: "Disabled Tests",
      href: "/disabled",
    },
    {
      name: "Cost Analysis",
      href: "/cost_analysis",
    },
    {
      name: "Query Execution Metrics",
      href: "/query_execution_metrics",
    },
    {
      name: "Build Time Metrics",
      href: "/build_time_metrics",
    },
    {
      name: "Utilization Workflow Report",
      href: "/utilization/report?group_by=workflow_name",
    },
    {
      name: "PyTorch Runners",
      href: "/runners/pytorch",
    },
  ];

  const metricsDropdown = [
    {
      name: "Metrics",
      href: "/metrics",
    },
    {
      name: (
        <span style={{ position: "relative" }}>
          Flambeau (PyTorch CI Agent)
          <span
            style={{
              marginLeft: "4px",
              padding: "2px 6px",
              fontSize: "10px",
              fontWeight: "bold",
              backgroundColor: "#FF6B35",
              color: "white",
              borderRadius: "8px",
              textTransform: "uppercase",
              lineHeight: "1",
            }}
          >
            BETA
          </span>
        </span>
      ),
      href: "/flambeau",
    },
    {
      name: "vLLM CI metrics",
      href: "/metrics/vllm",
    },
  ];

  return (
    <div className={styles.navbar}>
      <div>
        <ul className={styles.navbarlinkslist}>
          <li className={styles.homeLink}>
            <Link prefetch={false} href="/">
              PyTorch CI HUD
            </Link>
          </li>
          <li>
            <Link prefetch={false} href="/hud/pytorch/pytorch/main">
              PyTorch
            </Link>
          </li>
          <li>
            <Link prefetch={false} href="/hud/pytorch/executorch/main">
              ExecuTorch
            </Link>
          </li>
          <li>
            <Link prefetch={false} href="/hud/pytorch/vision/main">
              TorchVision
            </Link>
          </li>
          <li>
            <Link prefetch={false} href="/hud/pytorch/audio/main">
              TorchAudio
            </Link>
          </li>
          <li>
            <Link prefetch={false} href="/hud/pytorch/helion/main">
              Helion
            </Link>
          </li>
        </ul>
      </div>
      <div
        style={{
          marginLeft: "auto",
          marginRight: "0px",
          display: "flex",
          alignItems: "center",
        }}
      >
        <ul className={styles.navbarlinkslist}>
          <li>
            <Link href="https://github.com/pytorch/pytorch/wiki/Using-hud.pytorch.org">
              Help
            </Link>
          </li>
          <li>
            <Link href="https://github.com/pytorch/test-infra/issues/new?assignees=&labels=&template=feature_request.yaml&title=%5Bfeature%5D%3A+">
              Requests
            </Link>
          </li>
          <NavBarGroupDropdown title="Benchmarks" groups={benchmarkDropdown} />
          <NavBarDropdown title="Metrics" items={metricsDropdown} />
          <li>
            <Link prefetch={false} href="/kpis">
              KPIs
            </Link>
          </li>
          <NavBarDropdown title="Dev Infra" items={devInfraDropdown} />
          <li
            style={{ cursor: "pointer", display: "flex", alignItems: "center" }}
          >
            <Link
              href="https://github.com/pytorch/test-infra/tree/main/torchci"
              passHref
              style={{
                color: "var(--icon-color)",
                display: "flex",
                alignItems: "center",
              }}
            >
              <AiFillGithub />
            </Link>
          </li>
          <li>
            <ThemeModePicker />
          </li>
          <li>
            <LoginSection></LoginSection>
          </li>
        </ul>
      </div>
    </div>
  );
}

export default NavBar;

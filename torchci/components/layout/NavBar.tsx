import styles from "components/layout/NavBar.module.css";
import Link from "next/link";
import React, { useState } from "react";
import { AiFillGithub } from "react-icons/ai";
import ThemeModePicker from "../common/ThemeModePicker";
import LoginSection from "./LoginSection";

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
  const benchmarksDropdown = [
    {
      name: (
        <span style={{ position: "relative" }}>
          Benchmark Lists
          <span
            style={{
              marginLeft: "4px",
              padding: "2px 6px",
              fontSize: "10px",
              fontWeight: "bold",
              backgroundColor: "green",
              color: "white",
              borderRadius: "8px",
              textTransform: "uppercase",
              lineHeight: "1",
            }}
          >
            New!
          </span>
        </span>
      ),
      href: "/benchmark/benchmark_list",
    },
    {
      name: "Triton",
      href: "/tritonbench/commit_view",
    },
    {
      name: "PyTorch LLMs",
      href: "/benchmark/llms?repoName=pytorch%2Fpytorch",
    },
    {
      name: "ExecuTorch",
      href: "/benchmark/llms?repoName=pytorch%2Fexecutorch",
    },
    {
      name: "PT CacheBench",
      href: "/benchmark/llms?repoName=pytorch%2Fpytorch&benchmarkName=TorchCache+Benchmark",
    },
    {
      name: "vLLM v1",
      href: "/benchmark/llms?repoName=vllm-project%2Fvllm",
    },
    {
      name: "SGLang",
      href: "/benchmark/llms?repoName=sgl-project%2Fsglang",
    },
    {
      name: "Helion",
      href: "/benchmark/llms?repoName=pytorch%2Fhelion&benchmarkName=Helion+Benchmark",
    },
  ].sort((a, b) => {
    if (typeof a.name === "string" && typeof b.name === "string") {
      return a.name.localeCompare(b.name);
    }
    return 0; // leave order unchanged if either is not a string
  });

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
          <NavBarDropdown title="Metrics" items={metricsDropdown} />
          <li>
            <Link prefetch={false} href="/kpis">
              KPIs
            </Link>
          </li>
          <NavBarDropdown title="Benchmarks" items={benchmarksDropdown} />
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

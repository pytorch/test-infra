import { benchmarkNavGroup } from "components/benchmark_v3/pages/BenchmarkListPage";
import styles from "components/layout/NavBar.module.css";
import Link from "next/link";
import { AiFillGithub } from "react-icons/ai";
import ThemeModePicker from "../common/ThemeModePicker";
import LoginSection from "./LoginSection";
import { NavBarGroupDropdown, NavItem } from "./NavBarGroupDropdown";

function NavBar() {
  const benchmarkDropdown = benchmarkNavGroup;

  const devInfraDropdown: NavItem[] = [
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
    {
      name: "Test File Reports",
      href: "/tests/fileReport",
    },
  ].map((item) => ({
    label: item.name,
    route: item.href,
    type: "item",
  }));

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
    {
      name: "Autorevert Metrics",
      href: "/metrics/autorevert",
    },
    {
      name: "Claude Billing",
      href: "/claude_billing",
    },
  ].map((item) => ({
    label: item.name,
    route: item.href,
    type: "item" as const,
  }));

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
          <li>
            <Link prefetch={false} href="/kpis">
              KPIs
            </Link>
          </li>
          <NavBarGroupDropdown title="Benchmarks" items={benchmarkDropdown} />
          <NavBarGroupDropdown
            title={
              <Link
                href="/metrics"
                prefetch={false}
                onClick={(e) => {
                  const isTouchDevice =
                    typeof window !== "undefined" &&
                    ("ontouchstart" in window || navigator.maxTouchPoints > 0);
                  if (isTouchDevice) {
                    e.preventDefault();
                  }
                }}
              >
                Metrics ▾
              </Link>
            }
            // showCarrot false since the spacing is unusual if we use the
            // default
            showCarrot={false}
            items={metricsDropdown}
          />
          <NavBarGroupDropdown title="Dev Infra" items={devInfraDropdown} />
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
          <LoginSection></LoginSection>
        </ul>
      </div>
    </div>
  );
}

export default NavBar;

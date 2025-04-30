import styles from "components/NavBar.module.css";
import Link from "next/link";
import { useState } from "react";
import { AiFillGithub } from "react-icons/ai";
import LoginSection from "./LoginSection";
import ThemeModePicker from "./ThemeModePicker";

const NavBarDropdown = ({
  title,
  items,
}: {
  title: string;
  items: any;
}): JSX.Element => {
  const [dropdown, setDropdown] = useState(false);
  const dropdownStyle = dropdown ? { display: "block" } : {};

  return (
    <li
      onMouseEnter={() => setDropdown(true)}
      onMouseLeave={() => setDropdown(false)}
      style={{ padding: 0 }}
    >
      <div className={styles.dropdowntitle}>{title} ▾</div>
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
      name: "TorchInductor",
      href: "/benchmark/compilers",
    },
    {
      name: "TorchAO",
      href: "/benchmark/torchao",
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
      name: "TorchAO LLMs",
      href: "/benchmark/llms?repoName=pytorch%2Fao",
    },
    {
      name: "PT CacheBench",
      href: "/benchmark/llms?repoName=pytorch%2Fpytorch&benchmarkName=TorchCache+Benchmark",
    },
    {
      name: "vLLM v1",
      href: "/benchmark/llms?repoName=vllm-project%2Fvllm",
    },
  ];

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
            <Link prefetch={false} href="/minihud">
              MiniHUD
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
          <li>
            <Link prefetch={false} href="/metrics">
              Metrics
            </Link>
          </li>
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
          <li style={{ padding: "0 1rem" }}>
            <LoginSection></LoginSection>
          </li>
        </ul>
      </div>
    </div>
  );
}

export default NavBar;

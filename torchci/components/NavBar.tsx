import { Button as _Button, Box, MenuItem, Stack } from "@mui/material";
import styles from "components/NavBar.module.css";
import Link from "next/link";
import { AiFillGithub } from "react-icons/ai";
import LoginSection from "./LoginSection";
import ThemeModePicker from "./ThemeModePicker";
import { HoverDropDownMenu } from "./common/HoverDropDownMenu";

const MenuItemLink = ({
  href,
  name,
}: {
  href: string;
  name: string;
}): JSX.Element => {
  return (
    <Link href={href} prefetch={false}>
      <MenuItem>{name}</MenuItem>
    </Link>
  );
};

const Button = (props: any) => {
  // Make button as small as possible
  return (
    <_Button
      style={{ minWidth: 0, textTransform: "none", font: "inherit" }}
      {...props}
    />
  );
};

const ButtonLink = ({
  href,
  name,
}: {
  href: string;
  name: string;
}): JSX.Element => {
  return (
    <Link href={href} prefetch={false}>
      <Button>{name}</Button>
    </Link>
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
      name: "TorchBench",
      href: "/torchbench/userbenchmark",
    },
    {
      name: "Triton Compile",
      href: "/tritonbench/compile_time",
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
      name: "Nightly Branch",
      href: "/hud/pytorch/pytorch/nightly",
    },
    {
      name: "Nightly Dashboard",
      href: "/nightlies",
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

  const leftLinks = [
    {
      href: "/minihud",
      name: "MiniHUD",
    },
    {
      href: "/hud/pytorch/executorch/main",
      name: "ExecuTorch",
    },
    {
      href: "/hud/pytorch/vision/main",
      name: "TorchVision",
    },
    {
      href: "/hud/pytorch/audio/main",
      name: "TorchAudio",
    },
  ];

  return (
    <div className={styles.navbar}>
      <Stack
        padding={2}
        direction="row"
        spacing={2}
        sx={{
          justifyContent: "space-between",
        }}
      >
        <Stack
          direction="row"
          spacing={2}
          alignItems="center"
          useFlexGap
          sx={{ flexWrap: "wrap" }}
        >
          <Link href={"/"} prefetch={false}>
            <Button
              style={{
                textTransform: "none",
                font: "inherit",
                fontWeight: "bold",
              }}
            >
              PyTorch CI HUD
            </Button>
          </Link>
          {leftLinks.map((link) => (
            <ButtonLink key={link.name} href={link.href} name={link.name} />
          ))}
        </Stack>
        <Stack
          direction="row"
          spacing={2}
          alignItems="center"
          useFlexGap
          sx={{ flexWrap: "wrap" }}
        >
          <ButtonLink
            href="https://github.com/pytorch/pytorch/wiki/Using-hud.pytorch.org"
            name="Help"
          />
          <ButtonLink
            href="https://github.com/pytorch/test-infra/issues/new?assignees=&labels=&template=feature_request.yaml&title=%5Bfeature%5D%3A+"
            name="Requests"
          />
          <ButtonLink href="/metrics" name="Metrics" />
          <ButtonLink href="/kpis" name="KPIs" />
          <HoverDropDownMenu title="Benchmarks ▾">
            {benchmarksDropdown.map((item) => (
              <MenuItemLink key={item.name} href={item.href} name={item.name} />
            ))}
          </HoverDropDownMenu>
          <HoverDropDownMenu title="Dev Infra ▾">
            {devInfraDropdown.map((item) => (
              <MenuItemLink key={item.name} href={item.href} name={item.name} />
            ))}
          </HoverDropDownMenu>
          <Link
            href="https://github.com/pytorch/test-infra/tree/main/torchci"
            passHref
            style={{
              color: "var(--icon-color)",
            }}
          >
            <Button style={{ minWidth: "0px" }} color="inherit">
              <AiFillGithub />
            </Button>
          </Link>
          <ThemeModePicker />
          <Box>
            <LoginSection />
          </Box>
        </Stack>
      </Stack>
    </div>
  );
}

export default NavBar;

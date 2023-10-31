import styles from "components/NavBar.module.css";
import Link from "next/link";
import { AiFillGithub } from "react-icons/ai";
import LoginSection from "./LoginSection";
import { useState } from "react";

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
      name: "TorchBench",
      href: "/torchbench/userbenchmark",
    },
    // uncomment after some eyeballs are on this
    // {
    //   name: "Testing Overhead",
    //   href: "/testingoverhead"
    // }
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
          <li>
            <Link prefetch={false} href="/benchmark/compilers">
              TorchInductor
            </Link>
          </li>
          <NavBarDropdown title="Dev Infra" items={devInfraDropdown} />
          <li style={{ cursor: "pointer" }}>
            <Link
              href="https://github.com/pytorch/test-infra/tree/main/torchci"
              passHref
            >
              <a style={{ color: "black" }}>
                <AiFillGithub />
              </a>
            </Link>
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

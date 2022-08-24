import styles from "components/NavBar.module.css";
import Link from "next/link";
import { AiFillGithub } from "react-icons/ai";
import LoginSection from "./LoginSection";
function NavBar() {
  return (
    <div className={styles.linksContainer}>
      <div className={styles.links}>
        <div>
          <ul className={styles.menu}>
            <span className={styles.homeLink}>
              <Link prefetch={false} href="/">
                Pytorch CI HUD
              </Link>
            </span>
            <li>
              <Link prefetch={false} href="/minihud">
                MiniHUD
              </Link>
            </li>
            <li>
              <Link prefetch={false} href="/hud/pytorch/pytorch/master">
                Master
              </Link>
            </li>
            <li>
              <Link prefetch={false} href="/hud/pytorch/pytorch/nightly">
                Nightly
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
            display: "inline",
            marginLeft: "auto",
            marginRight: "0px",
            whiteSpace: "nowrap",
          }}
        >
          <ul style={{ marginBottom: "0" }} className={styles.menu}>
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
              <LoginSection />
            </li>
            <li>
              <Link prefetch={false} href="/tts">
                TTS
              </Link>
            </li>
            <li>
              <span style={{ cursor: "pointer" }}>
                <Link
                  href="https://github.com/pytorch/test-infra/tree/main/torchci"
                  passHref
                >
                  <a style={{ color: "black" }}>
                    <AiFillGithub />
                  </a>
                </Link>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default NavBar;

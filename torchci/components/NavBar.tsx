import styles from "components/NavBar.module.css";
import Link from "next/link";
import React from "react";
import { AiFillGithub } from "react-icons/ai";

function NavBar() {
  // TODO: Rewrite Help Link
  return (
    <div className={styles.linksContainer}>
      <div className={styles.links}>
        <div>
          <ul className={styles.menu}>
            <span className={styles.homeLink}>
              <Link href="/">Pytorch CI HUD</Link>
            </span>
            <li>
              <Link href="/hud/pytorch/pytorch/master">Master</Link>
            </li>
            <li>
              <Link href="/hud/pytorch/pytorch/nightly">Nightly</Link>
            </li>
            <li>
              <Link href="/minihud">MiniHUD</Link>
            </li>
          </ul>
        </div>
        <div
          style={{
            display: "inline",
            marginLeft: "auto",
            marginRight: "0px",
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
              <Link href="https://metrics.pytorch.org">Metrics</Link>
            </li>
            <li>
              <span style={{ color: "black", cursor: "pointer" }}>
                <Link
                  href="https://github.com/pytorch/test-infra/tree/main/torchci"
                  passHref
                >
                  <a>
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

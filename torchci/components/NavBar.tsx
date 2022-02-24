import styles from "components/NavBar.module.css";
import React from "react";
function NavBar() {
  // TODO: Rewrite Help Link
  return (
    <div className={styles.linksContainer}>
      <div className={styles.links}>
        <div>
          <ul className={styles.menu}>
            <a className={styles.homeLink} href="/">
              Pytorch CI HUD
            </a>
            <li>
              <a href="/hud/pytorch/pytorch/master">Master</a>
            </li>
            <li>
              <a href="/hud/pytorch/pytorch/nightly">Nightly</a>
            </li>
            <li>
              <a href="/minihud">MiniHUD</a>
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
              <a href="https://github.com/pytorch/pytorch/wiki/Using-hud.pytorch.org">
                Help
              </a>
            </li>
            <li>
              <a href="https://github.com/pytorch/test-infra/issues/new?assignees=&labels=&template=feature_request.yaml&title=%5Bfeature%5D%3A+">
                Requests
              </a>
            </li>
            <li>
              <a href="https://metrics.pytorch.org">Metrics</a>
            </li>
            <li>
              <a
                style={{ color: "black" }}
                href="https://github.com/pytorch/pytorch-ci-hud"
              ></a>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default NavBar;

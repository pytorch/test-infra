import React from "react";
import styles from "./AnnouncementBanner.module.css";

function AnnouncementBanner() {
  return (
    <div className={styles.announcementBanner}>
      <b>HUD Migration:</b> HUD is being migrated. If you would like to use the
      old HUD, go here to use the{" "}
      <a href={"https://hud2.pytorch.org/"}>old HUD</a> or{" "}
      <a href="https://github.com/pytorch/test-infra/issues/new?assignees=&labels=&template=feature_request.yaml&title=%5Bfeature%5D%3A+">
        file an issue
      </a>
      {" to let us know what's wrong."}
    </div>
  );
}

export default AnnouncementBanner;

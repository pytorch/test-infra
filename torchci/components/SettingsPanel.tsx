import React, { useEffect, useRef } from "react";
import styles from "./hud.module.css";

interface SettingsPanelProps {
  settingGroups: {
    [groupName: string]: React.ReactNode[];
  };
  isOpen: boolean;
  onToggle: () => void;
}

export default function SettingsPanel({
  settingGroups,
  isOpen,
  onToggle,
}: SettingsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Setup click outside handler
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        isOpen &&
        panelRef.current &&
        buttonRef.current &&
        !panelRef.current.contains(event.target as Node) &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        onToggle();
      }
    }

    // Add event listener when panel is open
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    // Clean up
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onToggle]);

  return (
    // position:relative is required here to establish a positioning context
    // for the absolutely positioned dropdown panel
    <div style={{ position: "relative" }}>
      <button
        ref={buttonRef}
        onClick={onToggle}
        className={styles.settingsButton}
      >
        Settings
        <span style={{ fontSize: "0.8rem" }}>{isOpen ? "▲" : "▼"}</span>
      </button>
      {isOpen && (
        <div ref={panelRef} className={styles.settingsPanel}>
          <div className={styles.settingsCategoryContainer}>
            {Object.entries(settingGroups).map(([groupName, settings]) => (
              <div key={groupName}>
                <h4 className={styles.settingsCategory}>{groupName}</h4>
                <div className={styles.settingsOptions}>
                  {settings.map((setting, index) => (
                    <React.Fragment key={index}>{setting}</React.Fragment>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

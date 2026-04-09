import { Paper, Tooltip } from "@mui/material";
import styles from "./autorevert.module.css";

function ColorBox({
  color,
  border,
  dashed,
}: {
  color?: string;
  border?: string;
  dashed?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        borderRadius: 2,
        backgroundColor: color,
        border: dashed
          ? "2px dashed #1976d2"
          : border
          ? `2px solid ${border}`
          : undefined,
        verticalAlign: "middle",
        marginRight: 3,
      }}
    />
  );
}

function Badge({
  label,
  cls,
  tooltip,
}: {
  label: string;
  cls: string;
  tooltip: string;
}) {
  return (
    <Tooltip title={tooltip} arrow>
      <span className={`${styles.legendBadge} ${cls}`}>{label}</span>
    </Tooltip>
  );
}

export default function AutorevertLegend() {
  return (
    <Paper
      variant="outlined"
      sx={{ px: 2, py: 0.75, mb: 1, fontSize: "0.8rem" }}
    >
      <div className={styles.legendRow}>
        {/* Status icons */}
        <span className={styles.legendGroup}>
          <span className={styles.legendLabel}>Events:</span>
          <span>
            <span className={styles.statusSuccess}>✓</span> passed
          </span>
          <span>
            <span className={styles.statusFailure}>✗</span> failed
          </span>
          <span>
            <span className={styles.statusPending}>●</span> pending
          </span>
        </span>

        <span className={styles.legendDivider}>|</span>

        {/* Cell colors */}
        <span className={styles.legendGroup}>
          <span className={styles.legendLabel}>Cell colors:</span>
          <span>
            <ColorBox color="rgba(211, 47, 47, 0.15)" border="#d32f2f" />{" "}
            suspect
          </span>
          <span>
            <ColorBox color="rgba(25, 118, 210, 0.12)" border="#1976d2" />{" "}
            baseline
          </span>
          <span>
            <ColorBox color="rgba(211, 47, 47, 0.08)" border="#e57373" /> newer
            failure
          </span>
          <span>
            <ColorBox dashed /> restart target
          </span>
          <span>
            <span
              style={{
                display: "inline-block",
                width: 12,
                height: 12,
                borderRadius: 2,
                border: "2px dashed #7b1fa2",
                verticalAlign: "middle",
                marginRight: 3,
              }}
            />{" "}
            AI dispatched
          </span>
        </span>

        <span className={styles.legendDivider}>|</span>

        {/* Outcome badges */}
        <span className={styles.legendGroup}>
          <span className={styles.legendLabel}>Decisions:</span>
          <Badge
            label="REV"
            cls={styles.outcomeRevert}
            tooltip="Autorevert pattern detected — commit will be reverted"
          />
          <Badge
            label="RST"
            cls={styles.outcomeRestart}
            tooltip="Needs more data — CI will be restarted on specific commits"
          />
          <Badge
            label="N/A"
            cls={styles.outcomeIneligible}
            tooltip="Not actionable — signal is flaky, fixed, or has insufficient data"
          />
        </span>

        <span className={styles.legendDivider}>|</span>

        {/* AI advisor badges */}
        <span className={styles.legendGroup}>
          <span className={styles.legendLabel}>AI advisor:</span>
          <Badge
            label="REV"
            cls={styles.advRevert}
            tooltip="AI advisor recommends revert"
          />
          <Badge
            label="OK"
            cls={styles.advNotRelated}
            tooltip="AI advisor says failure is not related to this commit"
          />
          <Badge
            label="JNK"
            cls={styles.advGarbage}
            tooltip="AI advisor says this signal is unreliable (infra flake)"
          />
          <Badge
            label="?"
            cls={styles.advUnsure}
            tooltip="AI advisor is unsure — autorevert continues normal flow"
          />
          <Badge
            label="AI"
            cls={styles.advDispatched}
            tooltip="AI advisor dispatched, awaiting result (pulsing)"
          />
        </span>
      </div>
    </Paper>
  );
}

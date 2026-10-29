import { Box, Tooltip, useTheme } from "@mui/material";
import CountedTokenLine from "components/tests/CountedTokenLine";
import FilterToken from "components/tests/FilterToken";
import type { EnvVarsRecord } from "lib/api/tests/types";
import {
  configToken,
  Token,
  variableLines,
  WORKFLOW_LINE_BUDGET,
  workflowTokens,
} from "lib/tests/environment";
import { headerBandColor } from "lib/tests/headerColors";

export interface ConfigProps {
  envVars: EnvVarsRecord | null;
  // The calling workflow paths of the configuration, from its health.
  workflowPaths: readonly string[];
  onFilter: (_filters: Token["filters"]) => void;
}

// Lines of NAME=value, as the variables tooltip lists them.
function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <Box
      component="span"
      sx={{ display: "block", whiteSpace: "pre", fontFamily: "monospace" }}
    >
      {lines.join("\n")}
    </Box>
  );
}

// A count beside the config name, in a small pill of the header band's grey:
// how many variables the set holds besides the config.
function VariablesBadge({ count }: { count: number }) {
  const theme = useTheme();
  return (
    <Box
      component="span"
      aria-label={`${count} more variable${count === 1 ? "" : "s"}`}
      sx={{
        ml: 0.75,
        px: 0.6,
        borderRadius: "999px",
        fontSize: theme.typography.caption.fontSize,
        lineHeight: 1.5,
        fontVariantNumeric: "tabular-nums",
        color: "text.secondary",
        backgroundColor: headerBandColor(theme),
        cursor: "default",
      }}
    >
      +{count}
    </Box>
  );
}

// How the test ran: the env var set's test config, "default", "slow",
// "inductor", full strength, with a badge counting the set's other variables;
// hovering either lists every variable of the set, the config included. Over
// them, the workflows that called it, "pull · trunk", muted and smaller, each
// by its file's name with its full path on hover. Every token filters on
// click. More workflows than the line holds are counted, "+1", and listed by
// path on hover, so nothing is cut off (CountedTokenLine, which the Owners
// cell shares).
export default function Config({
  envVars,
  workflowPaths,
  onFilter,
}: ConfigProps) {
  const token = envVars === null ? null : configToken(envVars);
  const variables = envVars === null ? [] : variableLines(envVars);
  const others =
    envVars === null
      ? 0
      : variableLines(envVars, { withoutConfig: true }).length;
  const workflows = workflowTokens(workflowPaths);
  const configLine = (
    <Box
      component="span"
      sx={{
        display: "flex",
        alignItems: "center",
        maxWidth: "100%",
        whiteSpace: "nowrap",
        color: token === null ? "text.secondary" : "text.primary",
      }}
    >
      {token === null ? (
        envVars === null ? (
          "unknown"
        ) : (
          "—"
        )
      ) : (
        <FilterToken token={token} onFilter={onFilter} />
      )}
      {others > 0 && <VariablesBadge count={others} />}
    </Box>
  );
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "flex-start",
        minWidth: 0,
        maxWidth: "100%",
        lineHeight: 1.25,
      }}
    >
      {variables.length === 0 ? (
        configLine
      ) : (
        <Tooltip title={<Lines lines={variables} />} enterDelay={300}>
          {configLine}
        </Tooltip>
      )}
      {workflows.length > 0 && (
        <CountedTokenLine
          tokens={workflows}
          budget={WORKFLOW_LINE_BUDGET}
          noun="workflow"
          onFilter={onFilter}
          sx={{
            fontSize: (theme) => theme.typography.caption.fontSize,
            color: "text.secondary",
          }}
        />
      )}
    </Box>
  );
}

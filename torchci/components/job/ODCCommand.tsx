import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import { Box, Stack } from "@mui/system";
import { useState } from "react";
import useSWR from "swr";

const STARTING_INSTRUCTIONS =
  "https://fb.workplace.com/groups/750343464652882/posts/750356391318256";

/**
 * Get the reproduction command for the job using osdc gpu-dev CLI
 *
 * https://github.com/wdvr/osdc
 *
 * Caveats:
 * - only on pytorch/pytorch repo
 * - only linux jobs
 * - only tests
 * - no building
 */
export function ODCommandInstructions({
  jobId,
  workflowId,
  failureLineNum,
  headSha,
}: {
  jobId: number;
  workflowId: number;
  failureLineNum: number;
  headSha: string;
}) {
  /**
   * Steps:
   * 1. Read the starting instructions to get setup with gpu-dev CLI
   * 2. Run the command to reserve a GPU
   * 3. ssh into the reserved machine
   * 4. Download binary
   * 5. Set environment variables
   * 6. Run command
   *
   * Example reserve gpu-dev command: gpu-dev reserve --gpu-type t4
   * --dockerimage
   * ghcr.io/pytorch/ci-image:pytorch-linux-jammy-py3.10-clang12-3bdcaae7001ead0f64837461a6
   *
   * Search the job log for:
   *   binary info
   *   docker image
   *   environment variables
   *     probably only care about PATH for now
   *   command
   *   gpu type
   *
   * In the future, this should probably be an artifact of the job
   *
   */

  const [open, setOpen] = useState(false);
  const reproInfo = useInformationFromJobLog(workflowId, jobId, failureLineNum);

  if (reproInfo === undefined) {
    return null;
  }

  const { gpuType, dockerImage, binaryURL, envVars, command } = reproInfo;

  function getInstructionsInsideMachine() {
    // Helper function for the initial setup commands inside the reserved
    // machine
    const instructions = [
      `# Use a tmp directory to avoid polluting your workspace`,
      `rm -rf /tmp/odc-repro && mkdir -p /tmp/odc-repro && cd /tmp/odc-repro`,
      `# Set up environment variables`,
      `export PATH=${envVars["PATH"]}:$PATH`,
      `# Clone pytorch repo`,
      `git clone https://github.com/pytorch/pytorch.git && cd pytorch && git checkout ${headSha}`,
      `# Download the binary artifacts`,
      `curl ${binaryURL} -o /tmp/odc-repro/artifacts.zip`,
      `unzip /tmp/odc-repro/artifacts.zip -d /tmp/odc-repro/artifacts`,
      `# Install the wheel `,
      `pip install $(echo /tmp/odc-repro/artifacts/dist/*.whl)[opt-einsum]`,
      `# Set up python path to use the local checkout`,
      `export PYTHONPATH=/tmp/odc-repro/pytorch:$PYTHONPATH`,
    ];
    return instructions.join("\n");
  }

  return (
    <>
      <Button
        size="small"
        onClick={() => setOpen(!open)}
        sx={{
          borderTop: 0,
          borderBottom: 0,
          mt: 0,
          mb: 0,
          pt: 0,
          pb: 0,
        }}
      >
        gpu-dev instructions
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>OSDC gpu-dev Reproduction Instructions</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography variant="body1">
              This is only available to Meta employees. You can use the OSDC
              gpu-dev CLI to reserve a machine similar to the one used in CI and
              reproduce the failure. Follow the instructions below to set up the
              gpu-dev CLI, reserve a machine, and run the command that failed in
              the CI job.
            </Typography>
            <Typography variant="body1">
              Currently this does not support rebuilding the binary, so
              modifications to cpp and other files will not be reflected.
            </Typography>

            <InstructionItem
              index={1}
              title="Set up OSDC gpu-dev CLI"
              component={
                <Typography variant="body1">
                  Follow the instructions{" "}
                  <a
                    href={STARTING_INSTRUCTIONS}
                    target="_blank"
                    rel="noreferrer"
                  >
                    here
                  </a>{" "}
                  to set up the OSDC gpu-dev CLI.
                </Typography>
              }
            />

            <InstructionItem
              index={2}
              title="Reserve a machine"
              component={
                <>
                  <Typography variant="body1">
                    Run the following command to reserve a machine similar to
                    the one used in CI:
                  </Typography>
                  <TerminalCopyBox
                    text={
                      `gpu-dev reserve --gpu-type ${gpuType} ` +
                      `--dockerimage ${dockerImage}`
                    }
                  />
                </>
              }
            />

            <InstructionItem
              index={3}
              title="SSH into the reserved machine"
              component={
                <Typography variant="body1">
                  The gpu-dev command to reserve a machine will provide an ssh
                  command.
                </Typography>
              }
            />
            <InstructionItem
              index={4}
              title="Download the binary"
              component={
                <>
                  <Typography variant="body1">
                    The following commands will clone pytorch, set up
                    environment variables, and download the binary:
                  </Typography>
                  <TerminalCopyBox text={getInstructionsInsideMachine()} />
                </>
              }
            />
            <InstructionItem
              index={5}
              title="Download the binary"
              component={
                <>
                  <Typography variant="body1">Run the test</Typography>
                  <TerminalCopyBox text={command} />
                </>
              }
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function InstructionItem({
  index,
  title,
  component,
}: {
  index: number;
  title: string;
  component: React.ReactNode;
}) {
  return (
    <Box>
      <Typography variant="subtitle1" fontWeight="bold">
        Step {index}: {title}
      </Typography>
      <Box>{component}</Box>
    </Box>
  );
}

/**
 * Component for displaying a box with monospace text that is copied on click.
 * Good for terminal commands.
 * @param param0
 * @returns
 */
function TerminalCopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Box
      sx={{
        backgroundColor: "#f5f5f5",
        padding: "10px",
        borderRadius: "5px",
        marginTop: "10px",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
      }}
      onClick={handleCopy}
      overflow={"auto"}
    >
      <Typography
        sx={{
          fontFamily: "monospace",
          whiteSpace: "pre",
          overflowX: "auto",
          flexGrow: 1,
        }}
      >
        {text}
      </Typography>

      <Tooltip title={copied ? "Copied!" : "Copy"}>
        <IconButton onClick={handleCopy} size="small">
          {copied ? (
            <CheckIcon fontSize="small" />
          ) : (
            <ContentCopyIcon fontSize="small" />
          )}
        </IconButton>
      </Tooltip>
    </Box>
  );
}

function useInformationFromJobLog(
  workflowId: number,
  jobId: number,
  failureLineNum: number
) {
  const logURL = `https://ossci-raw-job-status.s3.amazonaws.com/log/${jobId}`;
  const { data: log } = useSWR<string | undefined>(
    logURL,
    async (url) => {
      try {
        const response = await fetch(url);

        if (response.status === 404) {
          return undefined;
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to fetch: ${response.status} - ${errorText}`);
        }
        return await response.text();
      } catch (e) {
        return undefined;
      }
    },
    {
      refreshInterval: 0,
      revalidateOnFocus: false,
    }
  );

  if (log === undefined) {
    return undefined;
  }

  const noTimeStampLogLines = log
    .split("\n")
    .map((line) => line.slice("2025-10-22T19:23:27.2253709Z ".length));

  // Docker image
  const dockerImage = noTimeStampLogLines
    .find((line) => line.startsWith("docker pull ghcr.io/pytorch/ci-image:"))
    ?.slice("docker pull ".length);

  if (dockerImage === undefined) {
    return undefined;
  }

  // Binary URL
  const buildEnvironment = noTimeStampLogLines
    .find((line) => line.startsWith("  build-environment: "))
    ?.slice("  build-environment: ".length);
  if (buildEnvironment === undefined) {
    return undefined;
  }
  // https://gha-artifacts.s3.amazonaws.com/pytorch/pytorch/18726871000/linux-jammy-py3.10-gcc11-pch/artifacts.zip
  const binaryURL = `https://gha-artifacts.s3.amazonaws.com/pytorch/pytorch/${workflowId}/${buildEnvironment}/artifacts.zip`;

  // Command
  const reproCommandLine = noTimeStampLogLines
    .slice(0, failureLineNum - 1)
    .findLastIndex((line) =>
      line.startsWith(
        "To execute this test, run the following from the base repo dir:"
      )
    );
  if (reproCommandLine === -1) {
    return undefined;
  }
  const command = noTimeStampLogLines[reproCommandLine + 1].trim();

  // Machine type
  const runnerType = noTimeStampLogLines
    .find((line) => line.startsWith("Runner Type: "))
    ?.slice("Runner Type: ".length);
  // TODO: query gpu-dev to get available gpu types?  Query vantage and scale
  // config to get GPU architecture?
  let gpuType: string = "CPU-X86";
  if (runnerType?.includes("g6")) {
    gpuType = "L4";
  } else if (runnerType?.includes("g4dn")) {
    gpuType = "T4";
  }

  // envVars
  // Currently just PATH
  const path = noTimeStampLogLines
    .find((line) => line.startsWith("PATH="))
    ?.slice("PATH=".length);

  if (path === undefined) {
    return undefined;
  }

  return {
    gpuType,
    dockerImage,
    binaryURL,
    envVars: {
      PATH: path,
    },
    command,
  };
}

import { Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
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

export function OSDCommandInstructions({
  jobId,
  workflowId,
  failureLineNum,
}: {
  jobId: string;
  workflowId: number;
  failureLineNum: number;
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
   * Example gpu-dev command: gpu-dev reserve --gpu-type t4 --dockerimage  ghcr.io/pytorch/ci-image:pytorch-linux-jammy-py3.10-clang12-3bdcaae7001ead0f64837461a6
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
  const logURL = `https://ossci-raw-job-status.s3.amazonaws.com/log/${jobId}`;

  const log = useSWR<string | undefined>(
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

  if (log.data === undefined) {
    return <div>Unable to fetch job log to generate repro instructions.</div>;
  }

  const { gpuType, dockerImage, binaryURL, envVars, command } =
    useInformationFromJobLog(workflowId, log.data, failureLineNum);

  if (command === undefined || binaryURL === undefined || gpuType === undefined) {
    return <div>Unable to fetch information about the job to create repro instructions</div>
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h6">OSDC gpu-dev Repro Instructions</Typography>
      <Typography variant="body1">
        This is only available to Meta employees.
        You can use the OSDC gpu-dev CLI to reserve a machine similar to the one used in CI and reproduce the
        failure. Follow the instructions below to set up the gpu-dev CLI, reserve
        a machine, and run the command that failed in the CI job.
      </Typography>

      <InstructionItem
        index={1}
        title="Set up OSDC gpu-dev CLI"
        component={
          <Typography variant="body1">
            Follow the instructions{" "}
            <a href={STARTING_INSTRUCTIONS} target="_blank" rel="noreferrer">
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
          <Typography variant="body1">
            Run the following command to reserve a machine similar to the one
            used in CI:
            <Box
              component="pre"
              sx={{
                backgroundColor: "#f5f5f5",
                padding: "10px",
                borderRadius: "5px",
                marginTop: "10px",
              }}
            >
              gpu-dev reserve --gpu-type {gpuType.toLowerCase()}{" "}
              {dockerImage
                ? `--dockerimage ${dockerImage}`
                : "--no-docker"}
            </Box>
          </Typography>
        }
      />

      <InstructionItem
        index={3}
        title="SSH into the reserved machine"
        component={
          <Typography variant="body1">
            After reserving, ssh into the machine using the command provided by
            gpu-dev.
          </Typography>
        }
      />


    </Stack>
  );
}

function InstructionItem({index, title, component}: {index: number, title: string, component: React.ReactNode}) {
  return (
    <Box>
      <Typography variant="subtitle1" fontWeight="bold">
        Step {index}: {title}
      </Typography>
      <Box mt={1} mb={2}>
        {component}
      </Box>
    </Box>
  );
}

function useInformationFromJobLog(
  workflowId: number,
  log: string,
  failureLineNum: number
) {
  const noTimeStampLogLines = log
    .split("\n")
    .map((line) => line.slice("2025-10-22T19:23:27.2253709Z ".length));

  const noTimeStampLog = noTimeStampLogLines.join("\n");

  // Docker image
  const dockerImage = noTimeStampLogLines
    .find((line) => line.startsWith("docker pull ghcr.io/pytorch/ci-image:"))
    ?.slice("docker pull ".length);

  // https://gha-artifacts.s3.amazonaws.com/pytorch/pytorch/18726871000/linux-jammy-py3.10-gcc11-pch/artifacts.zip
  const buildEnvironment = noTimeStampLogLines
    .find((line) => line.startsWith("  build-environment: "))
    ?.slice("  build-environment: ".length);
  const binaryURL = buildEnvironment
    ? `https://gha-artifacts.s3.amazonaws.com/pytorch/pytorch/${workflowId}/${buildEnvironment}/artifacts.zip`
    : undefined;

  // Command
  const reproCommandLine = noTimeStampLogLines
    .slice(failureLineNum - 1)
    .findLastIndex((line) =>
      line.startsWith(
        "To execute this test, run the following from the base repo dir:"
      )
    );
  const command =
    reproCommandLine !== -1
      ? noTimeStampLogLines[reproCommandLine + 1].trim()
      : undefined;

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
  // Current just PATH
  const path = noTimeStampLogLines
    .find((line) => line.startsWith("PATH="))
    ?.slice("PATH=".length);

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

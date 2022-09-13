import {
  Box,
  Dialog,
  Divider,
  FormControl,
  Grid,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  TextField,
} from "@mui/material";
import Button from "@mui/material/Button";
import { GridCloseIcon } from "@mui/x-data-grid";
import { CommitData, JobData, PRData, ReviewData, RowData } from "lib/types";
import { useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { useState } from "react";
import {
  BsCheckCircleFill,
  BsFillExclamationTriangleFill,
  BsFillXCircleFill,
} from "react-icons/bs";
import { getMergeMessage, getPrURL } from "./GeneralUtils";
import { commentOnPR } from "./githubFunctions";
import { isFailure, isPending } from "./JobClassifierUtil";

const colors = {
  success: "green",
  warn: "orange",
  error: "red",
};

type MergeCheckType = "success" | "warn" | "error";
type ChecksMessage = { type: MergeCheckType; text: string };
const style = {
  width: "100%",
  maxWidth: 800,
  bgcolor: "background.paper",
};
type MergeType = {
  message: string;
  risk: string;
  eta: string;
  value: string;
};

export function MergeModal({
  prData,
  commit,
  jobs,
}: {
  prData: PRData;
  commit: CommitData;
  jobs: JobData[];
}) {
  const [open, setOpen] = useState(false);
  const handleOpen = () => setOpen(true);
  const handleClose = () => setOpen(false);

  if (prData.labels.includes("Merged") && prData.state === "closed") {
    return null;
  }

  return (
    <div style={{ position: "absolute", right: 16, top: 64 }}>
      <Button
        variant="contained"
        color="success"
        size="large"
        onClick={handleOpen}
      >
        Merge
      </Button>
      <Dialog
        maxWidth={"lg"}
        open={open}
        onClose={handleClose}
        aria-labelledby="modal-modal-title"
        aria-describedby="modal-modal-description"
      >
        <Box display="flex" alignItems="center">
          <div style={{ position: "absolute", top: 0, right: 0 }}>
            <IconButton onClick={handleClose}>
              <GridCloseIcon />
            </IconButton>
          </div>
          <MergeDialog prData={prData} commit={commit} jobs={jobs} />
        </Box>
      </Dialog>
    </div>
  );
}

function getMergeTypes(
  jobs: JobData[],
  labels: (string | undefined)[]
): {
  message: string;
  risk: string;
  eta: string;
  value: string;
}[] {
  const pendingJobs = jobs.filter((job) => isPending(job.conclusion));
  const hasExistingChecks =
    labels.includes("ciflow/trunk") && pendingJobs.length == 0;
  const landTypes = [
    {
      message:
        "Rebase on viable/strict, run Pull, Lint, and Trunk, and then merge ",
      risk: "Low",
      eta: hasExistingChecks ? "0-10 minutes" : "Up to 3-4 Hours",
      value: "l",
    },
    {
      message: "Check the signals on my PR and then merge ",
      risk: "Medium",
      eta: pendingJobs.length == 0 ? "0-10 minutes" : "Up to 3 hours",
      value: "g",
    },
    {
      message: "Merge immediately ",
      risk: "High",
      eta: "0-10 minutes",
      value: "f",
    },
  ];
  return landTypes;
}

function getStatusCheckMessage(jobs: JobData[]): ChecksMessage {
  const failedJobs = jobs.filter((job) => isFailure(job.conclusion));
  const pendingJobs = jobs.filter((job) => isPending(job.conclusion));
  if (failedJobs.length > 0) {
    return {
      type: "error",
      text: `There ${failedJobs.length == 1 ? "is" : "are"} ${
        failedJobs.length
      } failing check(s)`,
    };
  } else if (pendingJobs.length > 0) {
    return {
      type: "warn",
      text: `There  ${
        pendingJobs.length == 1 ? "is" : "are"
      } ${pendingJobs}.length pending checks`,
    };
  } else {
    return { type: "success", text: "All checks on PR are green" };
  }
}

function getApprovalMessage(reviews: ReviewData[]): ChecksMessage {
  const approvers = reviews.filter((review) => review.state === "APPROVED");
  if (approvers.length == 0) {
    return {
      type: "error",
      text: "There are no approvers",
    };
  } else {
    return {
      type: "success",
      text: `There are ${approvers.length} approvers`,
    };
  }
}

function getMergeableMessage(mergeable: boolean): ChecksMessage {
  if (mergeable) {
    return {
      type: "success",
      text: "This PR has no conflicts",
    };
  } else {
    return {
      type: "success",
      text: `There are conflicts on this PR. Please rebase locally`,
    };
  }
}

function MergeDialog({
  prData,
  commit,
  jobs,
}: {
  prData: PRData;
  commit: CommitData;
  jobs: JobData[];
}) {
  const router = useRouter();
  const { repoOwner, repoName, prNumber } = router.query;
  const statusCheckMessage = getStatusCheckMessage(jobs);
  const approversMessage = getApprovalMessage(prData.reviewData);
  const mergeableMessage = getMergeableMessage(prData.mergeable);
  const mergeTypes = getMergeTypes(jobs, prData.labels);
  return (
    <div style={{ margin: "32px", width: 800 }}>
      <Grid container spacing={2}>
        <h1>
          Land PR{" "}
          <a
            href={getPrURL(
              repoOwner as string,
              repoName as string,
              parseInt(prNumber as string)
            )}
          >
            #{prNumber}
          </a>
        </h1>
        <br></br>
        <div></div>
        <List sx={style} component="nav" aria-label="mailbox folders">
          <Divider light />
          <MergelistItem {...statusCheckMessage} />
          <MergelistItem {...approversMessage} />
          <MergelistItem {...mergeableMessage} />
        </List>
        <MergeSection mergeTypes={mergeTypes} />
      </Grid>
    </div>
  );
}

function MergeSection({ mergeTypes }: { mergeTypes: MergeType[] }) {
  const router = useRouter();
  const session = useSession();
  const [landType, setLandType] = useState(0);
  const [forceMessage, setForceMessage] = useState("");
  const message = getMergeMessage(mergeTypes[landType].value, forceMessage);
  const { repoOwner, repoName, prNumber } = router.query;
  const onClose = () => {
    router.push(
      getPrURL(
        repoOwner as string,
        repoName as string,
        parseInt(prNumber as string)
      )
    );
  };
  return (
    <>
      {landType === 2 && (
        <FormControl fullWidth>
          <TextField
            variant="outlined"
            multiline
            label="Force Message"
            placeholder="I need to land this ASAP"
            minRows={1}
            onChange={(e: any) => {
              e.preventDefault();
              setForceMessage(e.target.value);
            }}
          />
          <br />
        </FormControl>
      )}
      <div style={{ marginLeft: "auto" }}>
        <span style={{ marginRight: 16 }}>
          <FormControl style={{ minWidth: 400 }}>
            <Select
              autoWidth
              label={"Land"}
              aria-label="How do you want to land this"
              onChange={(e) => {
                e.preventDefault();
                setLandType(Number(e.target.value));
              }}
              defaultValue={0}
            >
              {mergeTypes.map((mergeType, ind) => (
                <MenuItem key={mergeType.value} value={ind}>
                  <b style={{ fontSize: "12px", margin: 0 }}>
                    {" "}
                    {mergeType.message}
                  </b>
                  <p style={{ fontSize: "12px", margin: 0 }}>
                    Risk: {mergeTypes[landType].risk} ETA:{" "}
                    {mergeTypes[landType].eta}
                  </p>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </span>
        <span style={{ alignItems: "center", height: "100%" }}>
          <Button
            style={{ height: "100%" }}
            variant="contained"
            color="success"
            size="large"
            onClick={() => {
              commentOnPR(
                repoOwner as string,
                repoName as string,
                String(prNumber),
                message,
                session?.data?.accessToken as string,
                onClose
              );
            }}
          >
            Merge
          </Button>
        </span>
      </div>
    </>
  );
}

function MergelistItem({ type, text }: ChecksMessage) {
  return (
    <>
      <ListItem divider>
        <div
          style={{
            background: colors[type],
            position: "absolute",
            left: 0,
            top: 0,
            width: 8,
            height: "100%",
            borderTopLeftRadius: 4,
            borderBottomLeftRadius: 4,
          }}
        ></div>
        <MergeIcon type={type} />
        <ListItemText primary={text} style={{ marginLeft: 4 }} />
      </ListItem>
      <Divider light />
    </>
  );
}

function MergeIcon({ type }: { type: MergeCheckType }) {
  if (type === "success") {
    return <BsCheckCircleFill color={colors[type]} />;
  } else if (type === "warn") {
    return <BsFillExclamationTriangleFill color={colors[type]} />;
  } else {
    return <BsFillXCircleFill color={colors[type]} />;
  }
}

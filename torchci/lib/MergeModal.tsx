import {
  Box,
  Dialog,
  Divider,
  Grid,
  IconButton,
  List,
  ListItem,
  ListItemText,
} from "@mui/material";
import Button from "@mui/material/Button";
import { GridCloseIcon } from "@mui/x-data-grid";
import { CommitData, JobData, PRData, RowData } from "lib/types";
import { useRouter } from "next/router";
import { useState } from "react";
import { getPrURL } from "./GeneralUtils";
import { isFailure } from "./JobClassifierUtil";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
const style = {
  width: "100%",
  maxWidth: 800,
  bgcolor: "background.paper",
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
  const approvers = prData.reviewData.filter(
    (review) => review.state === "APPROVED"
  );

  const failedJobs = jobs.filter((job) => isFailure(job.conclusion));

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
            {prNumber}
          </a>
        </h1>
        <br></br>
        <div>
          <pre>{JSON.stringify(approvers)}</pre>
          <pre>{JSON.stringify(failedJobs)}</pre>
          <pre>{JSON.stringify(prData.labels)}</pre>

          <List sx={style} component="nav" aria-label="mailbox folders">
            <ListItem button>
              <div
                style={{
                  background: "green",
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 8,
                  height: "100%",
                  borderTopLeftRadius: "6px",
                  borderBottomLeftRadius: "6px",
                }}
              ></div>
              <CheckCircleIcon />
              <ListItemText primary="Inbox" />
            </ListItem>
            <Divider />
            <ListItem button divider>
              <div
                style={{
                  background: "green",
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 50,
                }}
              ></div>
              <ListItemText primary="Drafts" />
            </ListItem>
            <ListItem button>
              <ListItemText primary="Trash" />
            </ListItem>
            <Divider light />
            <ListItem button>
              <ListItemText primary="Spam" />
            </ListItem>
          </List>
        </div>
      </Grid>
    </div>
  );
}

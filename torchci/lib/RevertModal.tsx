import {
  Box,
  Dialog,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem, Select, TextField
} from "@mui/material";
import Button from "@mui/material/Button";
import Grid from "@mui/material/Grid";
import { GridCloseIcon } from "@mui/x-data-grid";
import { revertClassifications } from "lib/bot/Constants";
import { getFailureMessage, getMessage } from "lib/GeneralUtils";
import { commentOnPR } from "lib/githubFunctions";
import { RowData } from "lib/types";
import { useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { useState } from "react";
import ReactMarkdown from "react-markdown";

const style = {
  position: "absolute" as "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: 800,
  bgcolor: "background.paper",
  border: "2px solid #000",
  boxShadow: 24,
  p: 4,
};

export function RevertModal({ row }: { row: RowData }) {
  const [open, setOpen] = useState(false);
  const handleOpen = () => setOpen(true);
  const handleClose = () => setOpen(false);

  return (
    <>
      <Button
        variant="contained"
        color="error"
        size="small"
        onClick={handleOpen}
      >
        Revert
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
        </Box>
        <Revert row={row} />
      </Dialog>
    </>
  );
}

export default function Revert({ row }: { row: RowData }) {
  const router = useRouter();

  const { repoOwner, repoName } = router.query;
  const prNumber = row.prNum;
  const [message, setMessage] = useState("");
  const [classification, setClassification] = useState("");
  const [disableButton, setDisableButton] = useState(false);

  const session = useSession();

  const msg = getMessage(
    message,
    classification,
    getFailureMessage(row, row.jobs)
  );

  if (session.status == "loading" || session.status == "unauthenticated") {
    return (
      <div>
        Error: You are not logged in. Please try revisiting this page after
        logging in.
      </div>
    );
  }

  const onClose = () => {
    router.push(`https://github.com/${repoOwner}/${repoName}/pull/${prNumber}`);
  };

  return (
    <div style={{ margin: "16px" }}>
      <Grid container spacing={2}>
        <Grid item xs={6}>
          <h1>
            Revert PR #{prNumber} in {repoOwner}/{repoName}
          </h1>
          <FormControl fullWidth>
            <TextField
              variant="outlined"
              multiline
              label="Revert Message"
              placeholder="This is breaking trunk"
              minRows={3}
              onChange={(e: any) => {
                e.preventDefault();
                setMessage(e.target.value);
              }}
            />
            <br />
          </FormControl>
          <FormControl fullWidth>
            <InputLabel>Revert Classification</InputLabel>
            <Select
              label={"Revert Classification"}
              defaultValue={Object.entries(revertClassifications)[0][0]}
              aria-label="What type of breakage is this"
              onChange={(e) => {
                e.preventDefault();
                setClassification(e.target.value);
              }}
            >
              {Object.entries(revertClassifications).map(
                ([classification, name]) => (
                  <MenuItem key={name} value={classification}>
                    {name}
                  </MenuItem>
                )
              )}
            </Select>
          </FormControl>
        </Grid>
        <Grid item xs={6}>
          <h1>Message Preview</h1>
          <div
            style={{
              border: "1px solid",
              borderRadius: "16px",
              padding: "8px",
              height: "100%",
            }}
          >
            <ReactMarkdown>{msg}</ReactMarkdown>
          </div>
        </Grid>
        <Grid item lg={12}>
          <Button
            style={{ marginTop: 32 }}
            fullWidth={true}
            variant="contained"
            type="submit"
            disabled={
              message.length == 0 || classification.length == 0 || disableButton
            }
            onClick={(e) => {
              e.preventDefault();
              setDisableButton(true);
              commentOnPR(
                repoOwner as string,
                repoName as string,
                String(prNumber),
                msg,
                session?.data?.accessToken as string,
                onClose
              );
            }}
          >
            Revert!
          </Button>
        </Grid>
      </Grid>
    </div>
  );
}

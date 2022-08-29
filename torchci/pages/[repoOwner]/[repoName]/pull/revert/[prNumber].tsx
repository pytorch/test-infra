import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextareaAutosize,
  TextField,
} from "@mui/material";
import Button from "@mui/material/Button";
import Grid from "@mui/material/Grid";
import { revertClassifications } from "lib/bot/Constants";
import { fetcher, getFailureMessage, getMessage } from "lib/GeneralUtils";
import { commentOnPR } from "lib/githubFunctions";
import { useSession } from "next-auth/react";
import Head from "next/head";
import { useRouter } from "next/router";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import useSWR from "swr";

export default function Revert() {
  const router = useRouter();
  const sha = router.query.sha;

  let { repoOwner, repoName, prNumber } = router.query;
  const [message, setMessage] = useState("");
  const [classification, setClassification] = useState("");
  const [disableButton, setDisableButton] = useState(false);
  const [response, setResponse] = useState("");
  const { data, error } = useSWR(
    `/api/${repoOwner}/${repoName}/commit/${sha}`,
    fetcher,
    {
      refreshInterval: 60 * 1000, // refresh every minute
      // Refresh even when the user isn't looking, so that switching to the tab
      // will always have fresh info.
      refreshWhenHidden: true,
    }
  );

  const session = useSession();

  const msg = getMessage(
    message,
    classification,
    getFailureMessage(data?.commit, data?.jobs)
  );

  if (error) {
    return (
      <div>Error while loading PR/Commit Data. Please try again later</div>
    );
  }

  if (session.status == "loading" || session.status == "unauthenticated") {
    return (
      <div>
        Error: You are not logged in. Please try revisiting this page after
        logging in.
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>
          Revert PR #{prNumber} in {repoOwner}/{repoName}
        </title>
      </Head>
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
            <br />
            <Button
              variant="contained"
              type="submit"
              disabled={
                message.length == 0 ||
                classification.length == 0 ||
                disableButton
              }
              onClick={(e) => {
                e.preventDefault();
                setDisableButton(true);
                commentOnPR(
                  repoOwner as string,
                  repoName as string,
                  prNumber as string,
                  msg,
                  session?.data?.accessToken as string,
                  (resp: string) => {
                    setResponse(resp);
                  }
                );
              }}
            >
              Revert!
            </Button>
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
        <pre>{response}</pre>
      </Grid>
    </>
  );
}

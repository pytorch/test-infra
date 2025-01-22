import { Box, Button, TextField } from "@mui/material";

function setURL(name: string, suite: string, file: string, limit: string) {
  window.location.href = `/flakytest?name=${encodeURIComponent(
    name
  )}&suite=${encodeURIComponent(suite)}&file=${encodeURIComponent(
    file
  )}&limit=${encodeURIComponent(limit)}`;
}

export default function TestSearchForm({
  name,
  suite,
  file,
}: {
  name: string;
  suite: string;
  file: string;
}) {
  return (
    <Box
      component="form"
      noValidate
      autoComplete="off"
      sx={{
        "& .MuiTextField-root": { m: 1, width: "25ch" },
        "& .MuiButton-root": { m: 2 },
      }}
      onSubmit={(e) => {
        e.preventDefault();
        // @ts-ignore
        setURL(e.target[0].value, e.target[2].value, e.target[4].value);
      }}
    >
      <TextField label="Test Name" defaultValue={name} />
      <TextField label="Test Suite/Class" defaultValue={suite} />
      <TextField label="Test File" defaultValue={file} />
      <Button variant="contained" color="primary" type="submit">
        Search
      </Button>
    </Box>
  );
}

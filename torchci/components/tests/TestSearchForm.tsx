import { Box, Button, TextField } from "@mui/material";
import { encodeParams } from "lib/GeneralUtils";

function setURL(name: string, suite: string, file: string) {
  window.location.href = `/tests/search?${encodeParams({
    name,
    suite,
    file,
  })}`;
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
        "& .MuiTextField-root": {
          marginRight: 1,
          width: "25ch",
        },
        "& .MuiButton-root": {
          marginTop: 1,
          marginBottom: 1,
          marginLeft: 2,
        },
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

import { Button, TextField } from "@mui/material";
import { Box } from "@mui/system";

// Component that has a text field and a button to submit. Good for submitting a
// filter
export function TextFieldSubmit({
  jobFilter,
  onSubmit,
  info,
}: {
  jobFilter: string;
  onSubmit: (jobFilter: string) => void;
  info: string;
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
        onSubmit(e.target[0].value);
      }}
    >
      <TextField label={info} defaultValue={jobFilter} />
      <Button variant="contained" color="primary" type="submit">
        Filter
      </Button>
    </Box>
  );
}

import {
  Box,
  FormControl,
  FormGroup,
  InputLabel,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@mui/material";

export interface ToggleIconPickerContent {
  value: string;
  icon: JSX.Element;
  tooltipContent: string;
}

export default function ToggleIconPicker({
  toggleList,
  type,
  setType,
}: {
  toggleList: ToggleIconPickerContent[];
  type: string;
  setType: any;
}) {
  return (
    <FormControl style={{ marginLeft: 10, minWidth: 100 }}>
      <InputLabel
        htmlFor="toggle-button-group"
        shrink
        style={{ marginBottom: 8 }}
      >
        Chart Type
      </InputLabel>
      <FormGroup>
        <ToggleButtonGroup
          exclusive
          value={type}
          onChange={(event: React.MouseEvent<HTMLElement>, newType: string) => {
            if (newType === null) {
              return;
            }
            setType(newType);
          }}
          style={{ height: 56 }}
          aria-label="toggle-button-group"
        >
          {toggleList.map((item, index) => {
            return (
              <ToggleButton key={index} value={item.value}>
                <Tooltip title={item.tooltipContent}>
                  <Box
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                  >
                    {item.icon}
                  </Box>
                </Tooltip>
              </ToggleButton>
            );
          })}
        </ToggleButtonGroup>
      </FormGroup>
    </FormControl>
  );
}

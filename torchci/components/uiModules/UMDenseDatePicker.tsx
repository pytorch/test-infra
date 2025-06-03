import { styled } from "@mui/system";
import { DatePicker } from "@mui/x-date-pickers";
import { Dayjs } from "dayjs";

const DenseDatePicker = styled(DatePicker)(({ theme }) => ({
  "& .MuiInputBase-root": {
    minWidth: 180,
    borderRadius: 0,
    fontSize: "0.875rem",
  },
  "& .MuiOutlinedInput-root": {
    borderRadius: 0,
  },
  "& .MuiIconButton-root": {
    padding: 4,
    minWidth: 32,
  },
}));

type UMDenseDatePickerProps = {
  label: string;
  value: Dayjs | null;
  onChange: (newDate: Dayjs | null) => void;
};

export function UMDenseDatePicker({
  label,
  value,
  onChange,
}: UMDenseDatePickerProps) {
  return (
    <DenseDatePicker
      label={label}
      value={value}
      onChange={onChange}
      slotProps={{
        textField: {
          size: "small",
          fullWidth: false,
        },
      }}
    />
  );
}

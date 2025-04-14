import { FormControl, InputLabel, MenuItem, Select } from "@mui/material";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";


export function TimeGranuityPicker(
  { granularity, setGranularity, enableHalfHour = false }
  :{
  granularity: any;
  setGranularity: (granularity: any) => void;
  enableHalfHour?: boolean;
  }
){
   return  <FormControl style={{ marginLeft: 10, minWidth: 100 }}>
            <InputLabel id="granularity-select-label">Granularity</InputLabel>
            <Select
              value={granularity}
              label="Granularity"
              labelId="granularity-select-label"
              onChange={(e) => setGranularity(e.target.value as Granularity)}
            >
              {enableHalfHour && <MenuItem value={"half_hour"}>Half Hour</MenuItem>}
              <MenuItem value={"hour"}>Hour</MenuItem>
              <MenuItem value={"day"}>Daily</MenuItem>
              <MenuItem value={"week"}>Weekly</MenuItem>
              <MenuItem value={"month"}>Monthly</MenuItem>
            </Select>
          </FormControl>
}

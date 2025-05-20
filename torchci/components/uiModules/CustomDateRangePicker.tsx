import * as React from 'react';
import { Box, Button, Stack, styled, TextField } from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import dayjs, { Dayjs } from 'dayjs';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';

const DenseButton = styled(Button)(({ theme }) => ({
    padding: '2px 2px',
    minHeight: '20px',
    fontSize: '0.75rem',
    color: "grey",
    minWidth: 'auto',
    borderRadius: 0,
    textTransform: 'none', // optional: avoids uppercase
  }));


  const presets = [
    { key: 'today', label: 'Today', days: 1 },
    { key: 'last2', label: 'Last 2 Days', days: 2 },
    { key: 'last7', label: 'Last 7 Days', days: 7 },
    { key: 'last14', label: 'Last 14 Days', days: 14 },
    { key: 'last30', label: 'Last 30 Days', days: 30 },
  ];


  interface PresetDateRangeSelectorProps {
    setStartTime?: (startDate: Dayjs) => void;
    setEndTime?: (endDate: Dayjs) => void;
  }

  export default function PresetDateRangeSelector({
    setStartTime = () => {},
    setEndTime = () => {},
  }: PresetDateRangeSelectorProps ) {
    const [startDate, setStartDate] = React.useState<Dayjs>(dayjs().utc().startOf('day').subtract(6, 'day'));
    const [endDate, setEndDate] = React.useState<Dayjs>(dayjs().utc());
    const [activePreset, setActivePreset] = React.useState<string | null>('today');

    const setRange = (days: number, key: string) => {
      const now = dayjs().utc();
      const start = now.startOf('day').subtract(days - 1, 'day');
      setStartDate(start);
      setEndDate(now);
      setActivePreset(key);

      setStartTime(start);
      setEndTime(now);
    };

    const handleManualStart = (newValue:any)=> {
      if (newValue) {
        setStartDate(newValue);
        setActivePreset(null);

        setStartTime(newValue);
        setEndTime(dayjs().utc());
      }
    };

    const handleManualEnd = (newValue: any) => {
      if (newValue) {
        setEndDate(newValue);
        setActivePreset(null);
      }
    };

    return (
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <Stack spacing={2}>
          {/* Preset Buttons */}
          <Stack direction="row" spacing={1}>
            {presets.map(({ key, label, days }) => (
              <DenseButton
                key={key}
                variant={activePreset === key ? 'contained' : 'outlined'}
                onClick={() => setRange(days, key)}
              >
                {label}
              </DenseButton>
            ))}
          </Stack>

          {/* Manual Pickers */}
          <Box sx={{ display: 'flex', gap: 2 }}>
            <DatePicker
              label="Start Date"
              value={startDate}
              onChange={handleManualStart}
              renderInput={(params) => <TextField {...params} size="small" />}
            />
            <DatePicker
              label="End Date"
              value={endDate}
              onChange={handleManualEnd}
              renderInput={(params) => <TextField {...params} size="small" />}
            />
          </Box>
        </Stack>
      </LocalizationProvider>
    );
  }

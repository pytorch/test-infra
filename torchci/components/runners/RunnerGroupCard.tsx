/**
 * @fileoverview Expandable card component for displaying grouped GitHub Actions runners
 *
 * This component displays a group of GitHub Actions runners in a collapsible card format.
 * Each card shows summary statistics (idle, busy, offline counts) and can be expanded to
 * reveal a detailed table of all runners in the group.
 *
 * Props:
 * - group: RunnerGroup data containing runners and metadata
 * - searchTerm: Filter string to highlight matching runners
 * - isExpanded: Controls whether the detailed view is shown
 * - onExpandChange: Callback when expand/collapse state changes
 *
 */

import {
  Box,
  Card,
  CardContent,
  Chip,
  Collapse,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useTheme,
} from "@mui/material";
import { ExpandLess, ExpandMore } from "@mui/icons-material";
import { useMemo } from "react";
import { RunnerGroup } from "lib/runnerUtils";
import { StatusChip } from "./StatusChip";

export function RunnerGroupCard({
  group,
  searchTerm,
  isExpanded,
  onExpandChange,
}: {
  group: RunnerGroup;
  searchTerm: string;
  isExpanded: boolean;
  onExpandChange: (_expanded: boolean) => void;
}) {
  const theme = useTheme();

  // Filter runners based on search term
  const filteredRunners = useMemo(() => {
    if (!searchTerm) return group.runners;

    const term = searchTerm.toLowerCase();
    return group.runners.filter(
      (runner) =>
        runner.name.toLowerCase().includes(term) ||
        runner.id.toString().includes(term) ||
        runner.os.toLowerCase().includes(term) ||
        runner.labels.some((label) => label.name.toLowerCase().includes(term))
    );
  }, [group.runners, searchTerm]);

  const handleExpandClick = () => {
    onExpandChange(!isExpanded);
  };

  return (
    <Card sx={{
      mb: 2,
      minHeight: 120,
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: theme.palette.mode === 'dark'
        ? '#3d3a00' // Dark yellow/amber
        : '#fffbf0', // Light cream-yellow
      '&:hover': {
        backgroundColor: theme.palette.mode === 'dark'
          ? '#4d4800'
          : '#fff8e1',
        opacity: 0.9,
      }
    }}>
      <CardContent>
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="center"
          onClick={handleExpandClick}
          sx={{ cursor: "pointer" }}
        >
          <Box>
            <Typography variant="h6" component="div">
              {group.label} ({filteredRunners.length} runners)
            </Typography>
            <Box display="flex" gap={1} mt={1}>
              <Chip
                label={`${group.idleCount} idle`}
                color="success"
                size="small"
              />
              <Chip
                label={`${group.busyCount} busy`}
                color="warning"
                size="small"
              />
              <Chip
                label={`${group.offlineCount} offline`}
                color="default"
                size="small"
              />
            </Box>
          </Box>
          <IconButton>
            {isExpanded ? <ExpandLess /> : <ExpandMore />}
          </IconButton>
        </Box>

        <Collapse in={isExpanded} timeout="auto" unmountOnExit>
          <Box mt={2}>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>ID</TableCell>
                    <TableCell>OS</TableCell>
                    <TableCell>Labels</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredRunners.map((runner) => (
                    <TableRow key={runner.id}>
                      <TableCell>{runner.name}</TableCell>
                      <TableCell>
                        <StatusChip runner={runner} />
                      </TableCell>
                      <TableCell>{runner.id}</TableCell>
                      <TableCell>{runner.os}</TableCell>
                      <TableCell>
                        <Box display="flex" flexWrap="wrap" gap={0.5}>
                          {runner.labels.map((label, index) => (
                            <Chip
                              key={index}
                              label={label.name}
                              size="small"
                              variant="outlined"
                            />
                          ))}
                        </Box>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        </Collapse>
      </CardContent>
    </Card>
  );
}
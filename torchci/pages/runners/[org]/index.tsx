import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Collapse,
  Container,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { ExpandLess, ExpandMore } from "@mui/icons-material";
import { useSession } from "next-auth/react";
import { useRouter } from "next/router";
import React, { useState, useMemo } from "react";
import useSWR from "swr";

// Types from our API
interface RunnerData {
  id: number;
  name: string;
  os: string;
  status: "online" | "offline";
  busy: boolean;
  labels: Array<{
    id?: number;
    name: string;
    type: "read-only" | "custom";
  }>;
}

interface RunnerGroup {
  label: string;
  totalCount: number;
  idleCount: number;
  busyCount: number;
  offlineCount: number;
  runners: RunnerData[];
}

interface RunnersApiResponse {
  groups: RunnerGroup[];
  totalRunners: number;
}

// Status chip component
function StatusChip({ runner }: { runner: RunnerData }) {
  let color: "success" | "warning" | "default";
  let label: string;

  if (runner.status === "offline") {
    color = "default";
    label = "offline";
  } else if (runner.busy) {
    color = "warning";
    label = "busy";
  } else {
    color = "success";
    label = "idle";
  }

  return (
    <Chip
      label={label}
      color={color}
      size="small"
      sx={{ minWidth: 80, fontWeight: "bold" }}
    />
  );
}

// Runner group card component
function RunnerGroupCard({
  group,
  searchTerm,
}: {
  group: RunnerGroup;
  searchTerm: string;
}) {
  const [expanded, setExpanded] = useState(false);

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
    setExpanded(!expanded);
  };

  return (
    <Card sx={{ mb: 2 }}>
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
            {expanded ? <ExpandLess /> : <ExpandMore />}
          </IconButton>
        </Box>

        <Collapse in={expanded} timeout="auto" unmountOnExit>
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

// Fetcher function for SWR
const fetcher = async (url: string) => {
  const { data: session } = await fetch("/api/auth/session").then(res => res.json());
  
  if (!session?.accessToken) {
    throw new Error("Not authenticated");
  }

  const response = await fetch(url, {
    headers: {
      Authorization: session.accessToken,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to fetch runners");
  }

  return response.json();
};

export default function OrgRunnersPage() {
  const router = useRouter();
  const { org } = router.query;
  const { data: session, status } = useSession();
  const [searchTerm, setSearchTerm] = useState("");

  // Fetch runners data
  const {
    data: runnersData,
    error,
    isLoading,
  } = useSWR<RunnersApiResponse>(
    org && session ? `/api/runners/${org}` : null,
    fetcher,
    {
      refreshInterval: 60000, // Refresh every minute
      revalidateOnFocus: true,
    }
  );

  // Filter groups based on search term
  const filteredGroups = useMemo(() => {
    if (!runnersData || !searchTerm) return runnersData?.groups || [];

    return runnersData.groups.filter((group) => {
      const term = searchTerm.toLowerCase();
      return (
        group.label.toLowerCase().includes(term) ||
        group.runners.some(
          (runner) =>
            runner.name.toLowerCase().includes(term) ||
            runner.id.toString().includes(term) ||
            runner.os.toLowerCase().includes(term) ||
            runner.labels.some((label) => label.name.toLowerCase().includes(term))
        )
      );
    });
  }, [runnersData, searchTerm]);

  if (status === "loading") {
    return (
      <Container maxWidth="lg" sx={{ mt: 4, textAlign: "center" }}>
        <CircularProgress />
        <Typography variant="body2" sx={{ mt: 2 }}>
          Loading authentication...
        </Typography>
      </Container>
    );
  }

  if (!session) {
    return (
      <Container maxWidth="lg" sx={{ mt: 4 }}>
        <Alert severity="error">
          You must be logged in to view runners information.
        </Alert>
      </Container>
    );
  }

  if (error) {
    return (
      <Container maxWidth="lg" sx={{ mt: 4 }}>
        <Alert severity="error">
          Error loading runners: {error.message}
        </Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ mt: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        GitHub Runners - {org}
      </Typography>

      <Box mb={3}>
        <TextField
          fullWidth
          variant="outlined"
          placeholder="Search runners by name, ID, OS, or labels..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          sx={{ maxWidth: 600 }}
        />
      </Box>

      {isLoading ? (
        <Box textAlign="center" py={4}>
          <CircularProgress />
          <Typography variant="body2" sx={{ mt: 2 }}>
            Loading runners...
          </Typography>
        </Box>
      ) : runnersData ? (
        <>
          <Typography variant="body1" color="text.secondary" gutterBottom>
            Total: {runnersData.totalRunners} runners
          </Typography>

          {filteredGroups.length === 0 ? (
            <Alert severity="info">
              No runners found matching your search criteria.
            </Alert>
          ) : (
            filteredGroups.map((group) => (
              <RunnerGroupCard
                key={group.label}
                group={group}
                searchTerm={searchTerm}
              />
            ))
          )}
        </>
      ) : null}
    </Container>
  );
}
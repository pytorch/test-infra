/**
 * @fileoverview GitHub Actions runners dashboard page
 *
 * Provides a comprehensive dashboard for viewing GitHub Actions
 * self-hosted runners at the organization level
 *
 * Supported routes:
 * - /runners/[org] - Show all runners for an organization (e.g., /runners/pytorch)
 *
 * Features:
 * - Organization-level runner monitoring and management
 * - Editable URL parameters using ParamSelector for easy navigation
 * - Real-time search filtering across runner names, IDs, OS, and labels
 *
 * State management:
 * - Uses SWR for data fetching with caching and revalidation
 * - Local state for search, sorting, and UI interactions
 *
 * UI/UX:
 * - Material-UI components with consistent theming
 * - Loading states and error handling with user-friendly messages
 * - Mobile-responsive layout with appropriate breakpoints
 *
 * Used by:
 * - TorchCI Dev Infra dropdown navigation
 * - Direct URL access for organization runner monitoring
 */

import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  CircularProgress,
  Container,
  Grid,
  TextField,
  Typography,
} from "@mui/material";
import { RunnerGroupCard } from "components/runners/RunnerGroupCard";
import { ParamSelector } from "lib/ParamSelector";
import { RunnersApiResponse, unknownGoesLast } from "lib/runnerUtils";
import { useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { useMemo, useState } from "react";
import useSWR from "swr";

// Define sort order constants to prevent typos
const SORT_ALPHABETICAL = "alphabetical";
const SORT_COUNT = "count";

type SortOrder = typeof SORT_ALPHABETICAL | typeof SORT_COUNT;

// Fetcher function for SWR
const runnersFetcher = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to fetch runners");
  }

  return response.json();
};

export default function RunnersPage() {
  const router = useRouter();
  const { org } = router.query;

  // Ensure org is a string
  const orgParam = typeof org === 'string' ? org : null;

  const { data: _session, status: _status } = useSession();
  const [searchTerm, setSearchTerm] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>(SORT_ALPHABETICAL);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  // Handle URL editing for organization
  const handleOrgSubmit = (newOrg: string) => {
    if (!newOrg) return;

    // Check if user entered a repo path like "pytorch/pytorch"
    if (newOrg.includes('/')) {
      alert('Only organization-level runners are supported. Please enter just the organization name (e.g., "pytorch").');
      return;
    }

    if (newOrg !== orgParam) {
      router.push(`/runners/${newOrg}`);
    }
  };

  // Determine API endpoint - only org-level supported
  const apiEndpoint = useMemo(() => {
    if (!orgParam) return null;
    return `/api/runners/${orgParam}`;
  }, [orgParam]);

  // Fetch runners data
  const {
    data: runnersData,
    error,
    isLoading,
  } = useSWR<RunnersApiResponse>(apiEndpoint, runnersFetcher, {
    revalidateOnFocus: false, // Disable revalidation on focus to reduce expensive API calls
  });

  // Filter and sort groups
  const filteredAndSortedGroups = useMemo(() => {
    let groups = runnersData?.groups || [];

    // Filter based on search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      groups = groups.filter(
        (group) =>
          group.label.toLowerCase().includes(term) ||
          group.runners.some(
            (runner) =>
              runner.name.toLowerCase().includes(term) ||
              runner.id.toString().includes(term) ||
              runner.os.toLowerCase().includes(term) ||
              runner.labels.some((label) =>
                label.name.toLowerCase().includes(term)
              )
          )
      );
    }

    // Sort groups
    const sortedGroups = [...groups].sort((a, b) => {
      // The unknown group always goes last
      const unknownComparison = unknownGoesLast(a, b);
      if (unknownComparison !== 0) return unknownComparison;

      if (sortOrder === SORT_ALPHABETICAL) {
        return a.label.localeCompare(b.label);
      } else {
        return b.totalCount - a.totalCount;
      }
    });

    return sortedGroups;
  }, [runnersData, searchTerm, sortOrder]);

  // Show loading state for invalid routes
  if (!orgParam) {
    return (
      <Container maxWidth="lg" sx={{ mt: 4 }}>
        <Alert severity="info">
          Please provide an organization in the URL (e.g., /runners/pytorch)
        </Alert>
      </Container>
    );
  }


  if (error) {
    return (
      <Container maxWidth="lg" sx={{ mt: 4 }}>
        <Alert severity="error">Error loading runners: {error.message}</Alert>
      </Container>
    );
  }

  // Generate page title and URL selector for organization
  const urlSelector = (
    <ParamSelector value={orgParam} handleSubmit={handleOrgSubmit} />
  );

  return (
    <Container maxWidth="lg" sx={{ mt: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        GitHub Runners - {urlSelector}
      </Typography>

      <Typography
        variant="subtitle1"
        color="text.secondary"
        gutterBottom
        sx={{ mb: 3 }}
      >
        Showing self-hosted GitHub Actions runners for the{" "}
        <strong>{orgParam}</strong> organization. These runners are available to
        all repositories within the organization.
      </Typography>

      <Box mb={3}>
        <TextField
          fullWidth
          variant="outlined"
          placeholder="Search runners by name, ID, OS, or labels..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          sx={{ maxWidth: 600, mb: 2 }}
        />

        <Box>
          <ButtonGroup variant="outlined" size="small">
            <Button
              variant={
                sortOrder === SORT_ALPHABETICAL ? "contained" : "outlined"
              }
              onClick={() => setSortOrder(SORT_ALPHABETICAL)}
            >
              Sort A-Z
            </Button>
            <Button
              variant={sortOrder === SORT_COUNT ? "contained" : "outlined"}
              onClick={() => setSortOrder(SORT_COUNT)}
            >
              Sort by Count
            </Button>
          </ButtonGroup>
        </Box>
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

          {filteredAndSortedGroups.length === 0 ? (
            <Alert severity="info">
              No runners found matching your search criteria.
            </Alert>
          ) : (
            <Grid container spacing={2}>
              {filteredAndSortedGroups.map((group) => {
                const isExpanded = expandedGroup === group.label;

                return (
                  <Grid
                    size={{
                      xs: 12,
                      md: isExpanded ? 12 : 6,
                      lg: isExpanded ? 12 : 4,
                    }}
                    key={group.label}
                  >
                    <RunnerGroupCard
                      group={group}
                      searchTerm={searchTerm}
                      isExpanded={isExpanded}
                      onExpandChange={(expanded) =>
                        setExpandedGroup(expanded ? group.label : null)
                      }
                    />
                  </Grid>
                );
              })}
            </Grid>
          )}
        </>
      ) : null}
    </Container>
  );
}

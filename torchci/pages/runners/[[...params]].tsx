/**
 * @fileoverview Unified GitHub Actions runners dashboard page
 *
 * Provides a comprehensive dashboard for viewing GitHub Actions
 * self-hosted runners using catch-all routing to handle both organization-level
 * and repository-level views
 *
 * Supported routes:
 * - /runners/[org] - Show all runners for an organization (e.g., /runners/pytorch)
 * - /runners/[org]/[repo] - Show runners for a specific repository (e.g., /runners/pytorch/pytorch)
 *
 * Features:
 * - Unified component handles both org and repo views with catch-all routing
 * - Editable URL parameters using ParamSelector for easy navigation
 * - Real-time search filtering across runner names, IDs, OS, and labels
 *
 * State management:
 * - Uses SWR for data fetching with caching and revalidation
 * - Local state for search, sorting, and UI interactions
 * - URL-driven navigation with proper encoding
 *
 * UI/UX:
 * - Material-UI components with consistent theming
 * - Loading states and error handling with user-friendly messages
 * - Accessible design with proper ARIA labels and keyboard navigation
 * - Mobile-responsive layout with appropriate breakpoints
 *
 * Authentication:
 * - Infrastructure in place for user session validation
 * - Currently bypassed for testing but ready for production
 * - Will validate write access to pytorch/pytorch when enabled
 *
 * Used by:
 * - TorchCI Dev Infra dropdown navigation
 * - Direct URL access for organization and repository runner monitoring
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
  // TODO: Remove this bypass before production - AUTH DISABLED FOR TESTING
  // const { data: session } = await fetch("/api/auth/session").then(res => res.json());
  //
  // if (!session?.accessToken) {
  //   throw new Error("Not authenticated");
  // }

  const response = await fetch(url, {
    // headers: {
    //   Authorization: session.accessToken,
    // },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to fetch runners");
  }

  return response.json();
};

export default function RunnersPage() {
  const router = useRouter();
  const { params } = router.query;

  // Parse the route parameters
  const routeParams = Array.isArray(params) ? params : [];
  const org = routeParams[0] || null;
  const repo = routeParams[1] || null;

  const { data: _session, status: _status } = useSession();
  const [searchTerm, setSearchTerm] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>(SORT_ALPHABETICAL);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  // Handle URL editing for organization
  const handleOrgSubmit = (newOrg: string) => {
    if (newOrg && newOrg !== org) {
      const newPath = repo
        ? `/runners/${newOrg}/${repo}`
        : `/runners/${newOrg}`;
      router.push(newPath);
    }
  };

  // Handle URL editing for org/repo combination
  const handleOrgRepoSubmit = (orgRepo: string) => {
    const parts = orgRepo.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      const [newOrg, newRepo] = parts;
      if (newOrg !== org || newRepo !== repo) {
        router.push(`/runners/${newOrg}/${newRepo}`);
      }
    } else if (parts.length === 1 && parts[0]) {
      // If only org provided, go to org-level view
      if (parts[0] !== org || repo) {
        router.push(`/runners/${parts[0]}`);
      }
    }
  };

  // Determine API endpoint based on route parameters
  const apiEndpoint = useMemo(() => {
    if (!org) return null;
    return repo ? `/api/runners/${org}/${repo}` : `/api/runners/${org}`;
  }, [org, repo]);

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
  if (!org) {
    return (
      <Container maxWidth="lg" sx={{ mt: 4 }}>
        <Alert severity="info">
          Please provide an organization in the URL (e.g., /runners/pytorch)
        </Alert>
      </Container>
    );
  }

  // TODO: Remove this bypass before production - AUTH DISABLED FOR TESTING
  // if (status === "loading") {
  //   return (
  //     <Container maxWidth="lg" sx={{ mt: 4, textAlign: "center" }}>
  //       <CircularProgress />
  //       <Typography variant="body2" sx={{ mt: 2 }}>
  //         Loading authentication...
  //       </Typography>
  //     </Container>
  //   );
  // }

  // if (!session) {
  //   return (
  //     <Container maxWidth="lg" sx={{ mt: 4 }}>
  //       <Alert severity="error">
  //         You must be logged in to view runners information.
  //       </Alert>
  //     </Container>
  //   );
  // }

  if (error) {
    return (
      <Container maxWidth="lg" sx={{ mt: 4 }}>
        <Alert severity="error">Error loading runners: {error.message}</Alert>
      </Container>
    );
  }

  // Generate page title and URL selector based on route type
  const urlSelector = repo ? (
    <ParamSelector
      value={`${org}/${repo}`}
      handleSubmit={handleOrgRepoSubmit}
    />
  ) : (
    <ParamSelector value={org} handleSubmit={handleOrgSubmit} />
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
        {repo ? (
          <>
            Showing self-hosted GitHub Actions runners for the{" "}
            <strong>
              {org}/{repo}
            </strong>{" "}
            repository. These are runners specifically assigned to this
            repository.
          </>
        ) : (
          <>
            Showing self-hosted GitHub Actions runners for the{" "}
            <strong>{org}</strong> organization. These runners are available to
            all repositories within the organization.
          </>
        )}
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
                    item
                    xs={12}
                    md={isExpanded ? 12 : 6}
                    lg={isExpanded ? 12 : 4}
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

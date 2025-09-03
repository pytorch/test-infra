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
import { useSession } from "next-auth/react";
import { useRouter } from "next/router";
import React, { useState, useMemo } from "react";
import useSWR from "swr";
import { RunnersApiResponse } from "lib/runnerUtils";
import { RunnerGroupCard } from "components/runners/RunnerGroupCard";
import { runnersFetcher } from "lib/runners/fetcher";
import { ParamSelector } from "lib/ParamSelector";

type SortOrder = 'alphabetical' | 'count';

export default function RunnersPage() {
  const router = useRouter();
  const { params } = router.query;
  
  // Parse the route parameters
  const routeParams = Array.isArray(params) ? params : [];
  const org = routeParams[0] || null;
  const repo = routeParams[1] || null;
  
  const { data: _session, status: _status } = useSession();
  const [searchTerm, setSearchTerm] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>('alphabetical');
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  // Handle URL editing for organization
  const handleOrgSubmit = (newOrg: string) => {
    if (newOrg && newOrg !== org) {
      const newPath = repo 
        ? `/runners/${encodeURIComponent(newOrg)}/${encodeURIComponent(repo)}`
        : `/runners/${encodeURIComponent(newOrg)}`;
      window.location.href = newPath;
    }
  };

  // Handle URL editing for org/repo combination
  const handleOrgRepoSubmit = (orgRepo: string) => {
    const parts = orgRepo.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      const [newOrg, newRepo] = parts;
      if (newOrg !== org || newRepo !== repo) {
        window.location.href = `/runners/${encodeURIComponent(newOrg)}/${encodeURIComponent(newRepo)}`;
      }
    } else if (parts.length === 1 && parts[0]) {
      // If only org provided, go to org-level view
      if (parts[0] !== org || repo) {
        window.location.href = `/runners/${encodeURIComponent(parts[0])}`;
      }
    }
  };

  // Determine API endpoint based on route parameters
  const apiEndpoint = useMemo(() => {
    if (!org) return null;
    return repo 
      ? `/api/runners/${org}/${repo}`
      : `/api/runners/${org}`;
  }, [org, repo]);

  // Fetch runners data
  const {
    data: runnersData,
    error,
    isLoading,
  } = useSWR<RunnersApiResponse>(
    apiEndpoint,
    runnersFetcher,
    {
      refreshInterval: 60000, // Refresh every minute
      revalidateOnFocus: true,
    }
  );

  // Filter and sort groups
  const filteredAndSortedGroups = useMemo(() => {
    let groups = runnersData?.groups || [];

    // Filter based on search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      groups = groups.filter((group) =>
        group.label.toLowerCase().includes(term) ||
        group.runners.some(
          (runner) =>
            runner.name.toLowerCase().includes(term) ||
            runner.id.toString().includes(term) ||
            runner.os.toLowerCase().includes(term) ||
            runner.labels.some((label) => label.name.toLowerCase().includes(term))
        )
      );
    }

    // Sort groups
    const sortedGroups = [...groups].sort((a, b) => {
      if (sortOrder === 'alphabetical') {
        // Unknown always goes last
        if (a.label === "unknown" && b.label !== "unknown") return 1;
        if (a.label !== "unknown" && b.label === "unknown") return -1;
        return a.label.localeCompare(b.label);
      } else {
        // Sort by count (descending), unknown still goes last
        if (a.label === "unknown" && b.label !== "unknown") return 1;
        if (a.label !== "unknown" && b.label === "unknown") return -1;
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
        <Alert severity="error">
          Error loading runners: {error.message}
        </Alert>
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
    <ParamSelector 
      value={org} 
      handleSubmit={handleOrgSubmit} 
    />
  );

  return (
    <Container maxWidth="lg" sx={{ mt: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        GitHub Runners - {urlSelector}
      </Typography>
      
      <Typography variant="subtitle1" color="text.secondary" gutterBottom sx={{ mb: 3 }}>
        {repo ? (
          <>
            Showing self-hosted GitHub Actions runners for the <strong>{org}/{repo}</strong> repository.
            These are runners specifically assigned to this repository.
          </>
        ) : (
          <>
            Showing self-hosted GitHub Actions runners for the <strong>{org}</strong> organization.
            These runners are available to all repositories within the organization.
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

        <ButtonGroup variant="outlined" size="small">
          <Button
            variant={sortOrder === 'alphabetical' ? 'contained' : 'outlined'}
            onClick={() => setSortOrder('alphabetical')}
          >
            Sort A-Z
          </Button>
          <Button
            variant={sortOrder === 'count' ? 'contained' : 'outlined'}
            onClick={() => setSortOrder('count')}
          >
            Sort by Count
          </Button>
        </ButtonGroup>
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
                    size={{ xs: 12, md: isExpanded ? 12 : 6, lg: isExpanded ? 12 : 4 }}
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
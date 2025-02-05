import { Paper, styled } from "@mui/material";

const InfoCard = styled(Paper)({
    padding: "10px",
    margin: "10px",
  });

  const InfoSection = styled('div')({
    padding: "10px",
    margin: "10px",
  });

  const JobInfoTitle = styled("span")({
    marginRight: "5px",
    fontSize: "16px",
    fontWeight: "bold",
  });

export const UtilizationJobInformation = ({
    workflowId,
    jobId,
    attempt,
    jobName,
    workflowName,
  }: {
    workflowId: string;
    jobId: string;
    attempt: string;
    jobName: string;
    workflowName: string;
  }) => {
    return (
        <InfoCard>
            <InfoSection>
              <JobInfoTitle>Job Name:</JobInfoTitle>
              <span>{jobName}</span>
            </InfoSection>
            <InfoSection>
              <JobInfoTitle>Workflow Name:</JobInfoTitle>
              <span>{workflowName}</span>
            </InfoSection>
            <InfoSection>
              <JobInfoTitle>Workflow(run)Id:</JobInfoTitle>
              <span>{workflowId}</span>
            </InfoSection>
            <InfoSection>
              <JobInfoTitle>Job Id:</JobInfoTitle>
              <span>{jobId}</span>
            </InfoSection>
            <InfoSection>
              <JobInfoTitle>Attempt:</JobInfoTitle>
              <span>{attempt}</span>
            </InfoSection>
        </InfoCard>
    );
  };

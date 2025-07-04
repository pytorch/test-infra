import { Alert, Box, CircularProgress, Typography } from "@mui/material";
import { GetServerSideProps } from "next";
import { useEffect, useState } from "react";
import { TorchAgentPage } from "../../../components/TorchAgentPage";

interface SharedChatPageProps {
  uuid: string;
  initialData?: any;
  error?: string;
}

export default function SharedChatPage({
  uuid,
  initialData,
  error,
}: SharedChatPageProps) {
  const [chatData, setChatData] = useState(initialData);
  const [loading, setLoading] = useState(!initialData && !error);
  const [fetchError, setFetchError] = useState(error);

  useEffect(() => {
    if (!initialData && !error) {
      fetchSharedChat();
    }
  }, [uuid, initialData, error]);

  const fetchSharedChat = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/torchagent-get-shared/${uuid}`);

      if (!response.ok) {
        throw new Error("Failed to load shared chat");
      }

      const data = await response.json();
      setChatData(data);
    } catch (err) {
      setFetchError(
        err instanceof Error ? err.message : "Failed to load shared chat"
      );
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Box
        display="flex"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        minHeight="100vh"
        gap={2}
      >
        <CircularProgress />
        <Typography>Loading shared chat...</Typography>
      </Box>
    );
  }

  if (fetchError) {
    return (
      <Box
        display="flex"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        minHeight="100vh"
        gap={2}
        p={3}
      >
        <Alert severity="error" sx={{ maxWidth: 500 }}>
          <Typography variant="h6" gutterBottom>
            Chat Not Found
          </Typography>
          <Typography variant="body2">{fetchError}</Typography>
        </Alert>
      </Box>
    );
  }

  return (
    <TorchAgentPage
      initialChatData={chatData}
      isSharedView={true}
      shareId={uuid}
    />
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const { uuid } = context.params as { uuid: string };

  try {
    // Try to fetch the shared chat data server-side for better SEO and initial load
    const response = await fetch(
      `${process.env.NEXTAUTH_URL}/api/torchagent-get-shared/${uuid}`
    );

    if (!response.ok) {
      return {
        props: {
          uuid,
          error: "Shared chat not found",
        },
      };
    }

    const data = await response.json();

    return {
      props: {
        uuid,
        initialData: data,
      },
    };
  } catch (error) {
    return {
      props: {
        uuid,
        error: "Failed to load shared chat",
      },
    };
  }
};

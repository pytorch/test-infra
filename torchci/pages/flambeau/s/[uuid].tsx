import { Alert, Box, CircularProgress, Typography } from "@mui/material";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { TorchAgentPage } from "../../../components/TorchAgentPage";

export default function SharedChatPage() {
  const router = useRouter();
  const { uuid } = router.query as { uuid: string };
  const [chatData, setChatData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (uuid) {
      fetchSharedChat();
    }
  }, [uuid]);

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

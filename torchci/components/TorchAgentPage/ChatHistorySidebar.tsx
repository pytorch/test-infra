import AddIcon from "@mui/icons-material/Add";
import ChatIcon from "@mui/icons-material/Chat";
import {
  Box,
  CircularProgress,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import React from "react";

interface ChatSession {
  sessionId: string;
  timestamp: string;
  date: string;
  filename: string;
  key: string;
  title?: string;
}

interface ChatHistorySidebarProps {
  drawerOpen: boolean;
  sidebarWidth: number;
  chatHistory: ChatSession[];
  selectedSession: string | null;
  isHistoryLoading: boolean;
  onStartNewChat: () => void;
  onLoadChatSession: (sessionId: string) => void;
  onClose: () => void;
}

export const ChatHistorySidebar: React.FC<ChatHistorySidebarProps> = ({
  drawerOpen,
  sidebarWidth,
  chatHistory,
  selectedSession,
  isHistoryLoading,
  onStartNewChat,
  onLoadChatSession,
  onClose,
}) => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));

  return (
    <Drawer
      variant={isMobile ? "temporary" : "persistent"}
      anchor="left"
      open={drawerOpen}
      onClose={isMobile ? onClose : undefined}
      ModalProps={{ keepMounted: true }}
      sx={{
        width: sidebarWidth,
        flexShrink: 0,
        "& .MuiDrawer-paper": {
          width: sidebarWidth,
          boxSizing: "border-box",
          ...(isMobile
            ? {}
            : {
                position: "relative",
                height: "100%",
              }),
        },
      }}
    >
      <Box sx={{ p: 2, borderBottom: "1px solid", borderColor: "divider" }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            mb: 2,
          }}
        >
          <Typography variant="h6">Chat History</Typography>
          <Tooltip title="New Chat">
            <IconButton onClick={onStartNewChat} color="primary">
              <AddIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <List sx={{ flexGrow: 1, overflow: "auto" }}>
        {isHistoryLoading ? (
          <ListItem
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              py: 3,
            }}
          >
            <CircularProgress size={24} />
            <Typography variant="body2" sx={{ mt: 1 }}>
              Loading History...
            </Typography>
          </ListItem>
        ) : chatHistory.length === 0 ? (
          <ListItem>
            <ListItemText
              primary="No chat history"
              secondary="Start a new conversation"
            />
          </ListItem>
        ) : (
          chatHistory.map((session) => (
            <ListItem key={session.sessionId} disablePadding>
              <ListItemButton
                selected={selectedSession === session.sessionId}
                onClick={() => onLoadChatSession(session.sessionId)}
              >
                <ChatIcon sx={{ mr: 1, opacity: 0.7 }} />
                <ListItemText
                  primary={session.title || session.timestamp}
                  secondary={session.title ? session.timestamp : session.date}
                />
              </ListItemButton>
            </ListItem>
          ))
        )}
      </List>
    </Drawer>
  );
};

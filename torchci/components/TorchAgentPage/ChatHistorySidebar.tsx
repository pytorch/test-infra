import AddIcon from "@mui/icons-material/Add";
import ChatIcon from "@mui/icons-material/Chat";
import MenuIcon from "@mui/icons-material/Menu";
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
} from "@mui/material";
import React from "react";

interface ChatSession {
  sessionId: string;
  timestamp: string;
  date: string;
  filename: string;
  key: string;
  status?: string;
  title?: string;
  displayedTitle?: string;
}

interface ChatHistorySidebarProps {
  drawerOpen: boolean;
  sidebarWidth: number;
  chatHistory: ChatSession[];
  selectedSession: string | null;
  isHistoryLoading: boolean;
  onStartNewChat: () => void;
  onLoadChatSession: (sessionId: string) => void;
  onToggleSidebar: () => void;
}

export const ChatHistorySidebar: React.FC<ChatHistorySidebarProps> = ({
  drawerOpen,
  sidebarWidth,
  chatHistory,
  selectedSession,
  isHistoryLoading,
  onStartNewChat,
  onLoadChatSession,
  onToggleSidebar,
}) => {
  return (
    <Drawer
      variant="persistent"
      anchor="left"
      open={drawerOpen}
      sx={{
        width: drawerOpen ? sidebarWidth : 0,
        flexShrink: 0,
        transition: "width 0.3s ease",
        "& .MuiDrawer-paper": {
          width: sidebarWidth,
          boxSizing: "border-box",
          position: "fixed",
          height: "calc(100vh - 80px)", // Fixed height instead of dynamic
          top: "80px", // Fixed top position
          left: 0,
          transition: "transform 0.3s ease",
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
          <Box sx={{ display: "flex", alignItems: "center" }}>
            <Tooltip title="Toggle sidebar">
              <IconButton
                onClick={onToggleSidebar}
                sx={{ mr: 1 }}
                aria-label="Toggle sidebar"
              >
                <MenuIcon />
              </IconButton>
            </Tooltip>
            <Typography variant="h6">Chat History</Typography>
          </Box>
          <Tooltip title="New Chat">
            <IconButton onClick={onStartNewChat} color="primary">
              <AddIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <List sx={{ flexGrow: 1, overflow: "auto" }}>
        {isHistoryLoading && chatHistory.length === 0 ? (
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
                {session.status === "in_progress" ? (
                  <CircularProgress size={14} sx={{ mr: 1 }} />
                ) : (
                  <ChatIcon sx={{ mr: 1, opacity: 0.7 }} />
                )}
                <ListItemText
                  primary={
                    session.displayedTitle || session.title || session.timestamp
                  }
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

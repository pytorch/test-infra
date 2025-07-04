import React, { useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography,
  CircularProgress,
  TextField,
  Alert,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ShareIcon from "@mui/icons-material/Share";

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  chatTitle: string;
}

export const ShareModal: React.FC<ShareModalProps> = ({
  open,
  onClose,
  sessionId,
  chatTitle,
}) => {
  const [isSharing, setIsSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleShare = async () => {
    setIsSharing(true);
    setError(null);

    try {
      const response = await fetch("/api/torchagent-share", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId }),
      });

      if (!response.ok) {
        throw new Error("Failed to share chat");
      }

      const data = await response.json();
      setShareUrl(data.shareUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to share chat");
    } finally {
      setIsSharing(false);
    }
  };

  const handleCopyLink = () => {
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl);
    }
  };

  const handleClose = () => {
    setShareUrl(null);
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Box display="flex" alignItems="center">
            <ShareIcon sx={{ mr: 1 }} />
            Share Chat
          </Box>
          <IconButton onClick={handleClose} size="small">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>

      <DialogContent>
        <Typography variant="h6" gutterBottom>
          {chatTitle}
        </Typography>

        {!shareUrl && (
          <>
            <Alert severity="warning" sx={{ mb: 2 }}>
              Sharing this chat will make it accessible to everyone with the link.
            </Alert>
            <Typography variant="body2" color="text.secondary">
              This will create a public, read-only version of your chat that anyone can view.
            </Typography>
          </>
        )}

        {shareUrl && (
          <Box>
            <Typography variant="body2" sx={{ mb: 2 }}>
              Your chat has been shared! Anyone with this link can view it:
            </Typography>
            <TextField
              fullWidth
              value={shareUrl}
              InputProps={{
                readOnly: true,
              }}
              sx={{ mb: 2 }}
            />
          </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={handleClose} color="secondary">
          Close
        </Button>
        {!shareUrl && (
          <Button
            onClick={handleShare}
            variant="contained"
            disabled={isSharing}
            startIcon={isSharing ? <CircularProgress size={16} /> : <ShareIcon />}
          >
            {isSharing ? "Sharing..." : "Make Public"}
          </Button>
        )}
        {shareUrl && (
          <Button onClick={handleCopyLink} variant="contained">
            Copy Link
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};
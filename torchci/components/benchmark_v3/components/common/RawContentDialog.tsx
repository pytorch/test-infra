import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import React, { useState } from "react";
import { StaticRenderViewOnlyContent } from "./StaticRenderViewOnlyContent";

export function RawContentDialog({
  data,
  component: CustomComponent,
  sx,
  title = "Raw View",
  buttonName = "Raw",
  type = "json",
}: {
  /** the data (JSON, text, etc.) to show */
  data: any;
  /** optional custom component renderer (when type = "component") */
  component?: React.ComponentType<{ data: any }>;
  sx?: any;
  title?: string;
  buttonName?: string;
  /** "json" | "text" | "component" */
  type?: "json" | "text" | "component";
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!data) return null;

  const jsonString = () => {
    if (type === "json") {
      try {
        return JSON.stringify(data, null, 2);
      } catch {
        return String(data);
      }
    }
    return "";
  };

  const handleCopy = async () => {
    try {
      let textToCopy = "";

      if (type === "json") textToCopy = jsonString();
      else if (type === "text") textToCopy = String(data);
      else textToCopy = JSON.stringify(data, null, 2);

      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("Copy failed:", e);
    }
  };

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        onClick={() => setOpen(true)}
        sx={{
          px: 0.5,
          py: 0,
          minWidth: "auto",
          lineHeight: 1,
          fontSize: "0.75rem",
          textTransform: "none",
          ...sx,
        }}
      >
        {buttonName}
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle sx={{ pr: 5 }}>
          {title}
          <IconButton
            onClick={() => setOpen(false)}
            sx={{ position: "absolute", right: 8, top: 8 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
          <Tooltip title={copied ? "Copied!" : "Copy"}>
            <IconButton
              onClick={handleCopy}
              sx={{ position: "absolute", right: 40, top: 8 }}
              size="small"
            >
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </DialogTitle>

        <DialogContent dividers>
          {type === "json" && (
            <Box
              component="pre"
              sx={{
                background: "#f6f8fa",
                p: 2,
                borderRadius: 1,
                fontSize: "0.8rem",
                lineHeight: 1.4,
                overflow: "auto",
                maxHeight: 500,
              }}
            >
              {jsonString()}
            </Box>
          )}

          {type === "text" && (
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
              {String(data)}
            </Typography>
          )}

          {type === "component" && CustomComponent ? (
            <CustomComponent data={data} />
          ) : null}
        </DialogContent>

        <DialogActions>
          <Button onClick={() => setOpen(false)} size="small">
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export function RenderRawContent({
  data,
  title,
  buttonName,
  type,
  component,
}: {
  data: any;
  title: string;
  buttonName: string;
  type: "json" | "component";
  component?: (data: any, title: string) => JSX.Element;
}) {
  return (
    <RawContentDialog
      data={data}
      title={title}
      type={type}
      component={component}
      buttonName={buttonName}
    />
  );
}

export function RenderStaticContent({
  data,
  title = "",
  buttonName = "View",
}: {
  data: any;
  title: string;
  buttonName: string;
}) {
  const renderStaticContent = (data: any) => {
    return <StaticRenderViewOnlyContent data={data} title={""} maxDepth={10} />;
  };
  return (
    <RawContentDialog
      data={data}
      title={title}
      type={"component"}
      component={renderStaticContent}
      buttonName={buttonName}
    />
  );
}

import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { Box, IconButton, Tooltip } from "@mui/material";
import React from "react";
import ReactMarkdown from "react-markdown";

const tipsMarkdown = `
### Tips & Tricks

- **Explore the data:** TorchAgent has access to a wide range of data, including PyTorch GitHub repository data, GitHub Actions CI data, benchmarking data, and more. You can ask questions about any of this data, and TorchAgent will generate the appropriate queries and dashboards for you
- ** Use natural language:** You can ask questions in plain English, e.g. "How long on average does it take to add the label 'triaged' to issues with label 'module: dynamo'? Average per week.".
- ** TorchAgent knows who you are:** You can use your GitHub username to filter results, e.g. "Show me the number issues I open per month, per repo".
- **Try tool actions:** Expand tool sections for more details - you can see sql queries used, go to Clickhouse and get the raw data for that query, or see the model's reasoning and table schemas.
- **Keyboard shortcut:** Press Cmd+Enter to submit
- **Feedback:** Use the thumbs up/down to help us improve TorchAgent! Submit feature requests or report issues with the feedback buttons on the top right corner of the page.
`;

export const TipsInfoButton: React.FC = () => (
  <Tooltip
    title={
      <Box sx={{ maxWidth: 350, p: 1 }}>
        <ReactMarkdown>{tipsMarkdown}</ReactMarkdown>
      </Box>
    }
    placement="bottom"
    arrow
    enterTouchDelay={0}
  >
    <IconButton size="small" sx={{ ml: 1 }} aria-label="Tips & Tricks">
      <InfoOutlinedIcon fontSize="small" />
    </IconButton>
  </Tooltip>
);

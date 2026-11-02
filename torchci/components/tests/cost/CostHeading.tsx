import { Box, Typography } from "@mui/material";

// The title names what the page counts and whose: "Runner-hours of
// pytorch/pytorch". What the hours cover, their days and the workflow scope,
// is said by the facts under it, so the title stays the same as the page
// grows to other spans.
export default function CostHeading({ repo }: { repo: string | undefined }) {
  return (
    <Typography variant="h4" component="h1" sx={{ lineHeight: 1.5 }}>
      {repo === undefined ? (
        "CI cost"
      ) : (
        <>
          Runner-hours of{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {repo}
          </Box>
        </>
      )}
    </Typography>
  );
}

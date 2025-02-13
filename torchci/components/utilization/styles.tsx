import { Paper, styled } from "@mui/material";

export const Divider = styled("div")({
  borderBottom: "1px solid #ccc",
  margin: "20px 0",
});

export const MainPage = styled("div")({
  fontFamily: "Verdana, sans-serif",
});

export const Section = styled("div")({
  margin: "10px",
  padding: "10px",
});

export const InfoCard = styled(Paper)({
  padding: "10px",
  margin: "10px",
});

export const InfoSection = styled("div")({
  padding: "10px",
  margin: "10px",
});

export const InfoTitle = styled("span")({
  marginRight: "5px",
  fontSize: "16px",
  fontWeight: "bold",
});

export const FlexSection = styled("div")({
  margin: "5px",
  display: "flex",
});

export const Description = styled("div")({
  margin: "10px",
  padding: "10px",
  fontSize: "20px",
});

export const Blank = styled(Paper)({
  margin: "10px",
  padding: "10px",
  height: "400px",
});

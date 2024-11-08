import { CircularProgress, styled } from "@mui/material";
import React from "react";

const LoadingContainer = styled("div")(({}) => ({
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "center",
  height: "700px",
}));

const LoadingItem = styled("div")(({}) => ({
  margin: "10px",
}));

function LoadingPage() {
  return (
    <>
      <LoadingContainer>
        <div>
          <em> Loading...</em>
        </div>
        <LoadingItem>
          <CircularProgress />
        </LoadingItem>
      </LoadingContainer>
    </>
  );
}
export default LoadingPage;

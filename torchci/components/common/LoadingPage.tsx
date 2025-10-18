import { CircularProgress, styled } from "@mui/material";
import { Box } from "@mui/system";

const LoadingContainer = styled("div")(({}) => ({
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "center",
  height: "700px",
}));

const LoadingItem = styled(Box)(({}) => ({
  margin: "10px",
}));

function LoadingPage({
  height,
  width,
  content = "Loading...",
}: {
  height?: number;
  width?: number | string;
  content?: string;
}) {
  const style = {
    height: height ? height : "100%",
    width: width ? width : "100%",
  };
  return (
    <>
      <LoadingContainer style={style}>
        <div>
          <em> {content}</em>
        </div>
        <LoadingItem>
          <CircularProgress />
        </LoadingItem>
      </LoadingContainer>
    </>
  );
}
export default LoadingPage;

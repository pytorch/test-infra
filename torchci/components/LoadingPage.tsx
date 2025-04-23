import { CircularProgress, styled } from "@mui/material";

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

function LoadingPage({
  height,
  width,
}: {
  height?: number;
  width?: number | string;
}) {
  const style = {
    height: height ? height : "100%",
    width: width ? width : "100%",
  };
  return (
    <>
      <LoadingContainer style={style}>
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

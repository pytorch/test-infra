import styled from "@emotion/styled";

export const RainbowScrollStyle = {
  "&::-webkit-scrollbar": {
    width: "16px",
  },
  "&::-webkit-scrollbar-track": {
    backgroundColor: "#f0faff",
    borderRadius: "10px",
  },
  "&::-webkit-scrollbar-thumb": {
    background: "linear-gradient(180deg, #ffa7c4, #9bf6ff, #bdb2ff)",
    borderRadius: "10px",
    border: "2px solid white",
  },
  "&::-webkit-scrollbar-thumb:hover": {
    background: "linear-gradient(180deg, #ff8fa3, #aaa0ff)",
  },
};

export const FontSizeStyles = {
  fontSize: "0.85rem",
};

export const DropboxSelectDense = {
  "& .MuiSelect-select": {
    padding: "12px 8px", // adjust dropdown button padding
  },
};

export const DenseTextField = {
  "& .MuiInputBase-input": {
    fontSize: "0.85rem", // input text size
    padding: "10px 8px",
  },
  "& .MuiInputLabel-root": {
    fontSize: "0.85rem", // label text size
  },
};

export const DenseCheckbox = {
  p: 0.5, // reduce padding
  "& .MuiSvgIcon-root": {
    fontSize: 16, // shrink checkbox icon (default is 24)
  },
};

export const FlexDiv = styled("div")({
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-start",
  alignItems: "center",
});

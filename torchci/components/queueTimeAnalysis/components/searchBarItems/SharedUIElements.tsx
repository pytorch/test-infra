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

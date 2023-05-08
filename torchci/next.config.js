/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/",
        destination: "/hud/pytorch/pytorch/main/1",
      },
      {
        source: "/commit/:repoOwner/:repoName/:sha",
        destination: "/:repoOwner/:repoName/commit/:sha",
      },
      {
        source: "/pr/:repoOwner/:repoName/:prNumber",
        destination: "/:repoOwner/:repoName/pull/:prNumber",
      },
      {
        source: "/pr/:prNumber",
        destination: "/pytorch/pytorch/pull/:prNumber",
      },
      {
        source: "/commit/:sha",
        destination: "/pytorch/pytorch/commit/:sha",
      },
      {
        source: "/ci/:repoOwner/:repoName/:branch",
        destination: "/hud/:repoOwner/:repoName/:branch/1",
      },
      {
        source: "/minihud",
        destination: "/minihud/pytorch/pytorch/main/1",
      },
      {
        source: "/tts",
        destination: "/tts/pytorch/pytorch/main",
      },
      {
        source: "/reliability",
        destination: "/reliability/pytorch/pytorch",
      },
    ];
  },
};

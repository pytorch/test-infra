/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/",
        destination: "/hud/pytorch/pytorch/master/0",
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
    ];
  },
};

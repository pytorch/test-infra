/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/",
        destination: "/hud/pytorch/pytorch/master/0",
      },
    ];
  },
};

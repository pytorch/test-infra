const nextJest = require("next/jest");

const createJestConfig = nextJest({
  dir: "./",
});

const customJestConfig = {
  moduleDirectories: ["node_modules", "<rootDir>/"],
  reporters: ["<rootDir>/test/reporter.js"],
  //moduleNameMapper: {
  //  // A bug in jest config https://github.com/opensearch-project/opensearch-js/issues/410
  //  "@opensearch-project/opensearch/aws":
  //    "@opensearch-project/opensearch/lib/aws/index.js",
  //},
};

module.exports = createJestConfig(customJestConfig);

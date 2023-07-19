const nextJest = require("next/jest");

const createJestConfig = nextJest({
  dir: "./",
});

const customJestConfig = {
  moduleDirectories: ["node_modules", "<rootDir>/"],
  reporters: ['<rootDir>/test/reporter.js'],
};

module.exports = createJestConfig(customJestConfig);

const { defaults } = require("jest-config");

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest/presets/js-with-ts',
  testEnvironment: 'node',
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.{ts,js,jsx}'],
  reporters: ['<rootDir>/test/reporter.js'],
  coverageThreshold: {
    global: {
      branches: 0,
      functions: 0,
      lines: 0,
      statements: 0
    }
  },
  testPathIgnorePatterns: ["<rootDir>/node_modules/"],
  transformIgnorePatterns: [
    // "node_modules/(?!(@octokit/webhooks/.+|aggregate-error/.+|indent-string/.+|clean-stack/.+))"
    "should_notMatchAnything"
  ],
  moduleNameMapper: {
    '^#home-directory$': '<rootDir>/node_modules/clean-stack/home-directory.js',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
};

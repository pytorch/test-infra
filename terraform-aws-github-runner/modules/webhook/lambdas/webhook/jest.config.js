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
  transformIgnorePatterns: [
    // "node_modules/(?!(@octokit/webhooks/.+|aggregate-error/.+|indent-string/.+|clean-stack/.+))"
    "should_notMatchAnything"
  ],
  // moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'node'],
  // transform: {
  //   // '^.+\\.[tj]sx?$' to process js/ts with `ts-jest`
  //   // '^.+\\.m?[tj]sx?$' to process js/ts/mjs/mts with `ts-jest`
  //   '^.+\\.tsx?$': [
  //     'ts-jest',
  //     {
  //       // ts-jest configuration goes here
  //     },
  //   ],
  // },
};

module.exports = {
    clearMocks: true,
    moduleFileExtensions: ['js', 'ts'],
    roots: ['<rootDir>'],
    testEnvironment: 'node',
    testMatch: ['**/*.test.ts'],
    testRunner: 'jest-circus/runner',
    extensionsToTreatAsEsm: ['.ts'],
    transform: {
      '^.+\\.js?$': 'babel-jest',
      '^.+\\.ts$': [
        'ts-jest',
        {
          useESM: true,
          tsconfig: 'tsconfig.json'
        }
      ]
    },
    transformIgnorePatterns: ['/node_modules/(?!mime)'],
    verbose: true
  }
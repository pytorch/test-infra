import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files
    include: ['__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],

    // Environment
    environment: 'node',

    // Don't watch by default
    watch: false,

    // Coverage
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },

    // Globals for easier testing
    globals: true,

    // Setup files
    setupFiles: ['__tests__/utils/test-setup.ts'],
  },
});
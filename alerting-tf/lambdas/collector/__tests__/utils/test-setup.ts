// Global test setup for Vitest

// Mock environment variables
process.env.STATUS_TABLE_NAME = 'test-alerts-state';
process.env.GITHUB_REPO = 'test-org/test-repo';
process.env.GITHUB_APP_SECRET_ID = 'test-secret';
process.env.ENABLE_GITHUB_ISSUES = 'false'; // Disable for most tests

// Mock AWS region
process.env.AWS_REGION = 'us-east-1';

// Silence console logs during tests (can be enabled for debugging)
const originalConsole = { ...console };
global.console = {
  ...console,
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

// Restore console for specific tests if needed
global.restoreConsole = () => {
  global.console = originalConsole;
};
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '../.env.local') });

// Mock AWS Lambda context and response stream for local testing
class MockResponseStream {
  constructor() {
    this.chunks = [];
    this.ended = false;
    this.destroyed = false;
  }

  write(chunk) {
    if (!this.ended && !this.destroyed) {
      this.chunks.push(chunk.toString());
      process.stdout.write(chunk);
    }
  }

  end() {
    this.ended = true;
    console.log('\n--- Response Stream Ended ---');
  }

  getOutput() {
    return this.chunks.join('');
  }
}

// Mock awslambda.streamifyResponse
global.awslambda = {
  streamifyResponse: (handler) => handler,
  HttpResponseStream: {
    from: (stream, options) => {
      console.log('Response headers:', options.headers);
      return stream;
    }
  }
};

// Import our Lambda function
const lambdaFunction = require('../lambda_function');

// Test utilities
const createTestEvent = (query) => ({
  body: JSON.stringify({ query }),
  headers: {
    'Content-Type': 'application/json'
  }
});

const createMockContext = () => ({
  awsRequestId: 'test-request-id',
  functionName: 'test-function',
  functionVersion: '1',
  getRemainingTimeInMillis: () => 300000
});

// Test cases
const tests = [
  {
    name: 'Basic Query Test',
    query: 'Hello, can you help me?',
    timeout: 30000
  },
  {
    name: 'ClickHouse Tables Query',
    query: 'What tables are available in ClickHouse?',
    timeout: 60000
  },
  {
    name: 'Simple Dashboard Request',
    query: 'Create a simple dashboard with a text panel',
    timeout: 120000
  },
  {
    name: 'Complex Query Test',
    query: 'Show me the schema of the default database in ClickHouse and create a dashboard with a query panel',
    timeout: 180000
  }
];

// Test runner
async function runTest(test) {
  console.log(`\n=== Running Test: ${test.name} ===`);
  console.log(`Query: ${test.query}`);
  console.log(`Timeout: ${test.timeout}ms`);
  
  const event = createTestEvent(test.query);
  const context = createMockContext();
  const responseStream = new MockResponseStream();
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      console.log(`Test "${test.name}" timed out after ${test.timeout}ms`);
      resolve({
        name: test.name,
        status: 'timeout',
        output: responseStream.getOutput(),
        error: 'Test timed out'
      });
    }, test.timeout);

    try {
      // Run the Lambda handler
      const result = lambdaFunction.handler(event, responseStream, context);
      
      if (result && typeof result.then === 'function') {
        result.then(() => {
          clearTimeout(timer);
          resolve({
            name: test.name,
            status: 'success',
            output: responseStream.getOutput()
          });
        }).catch((error) => {
          clearTimeout(timer);
          resolve({
            name: test.name,
            status: 'error',
            output: responseStream.getOutput(),
            error: error.message
          });
        });
      } else {
        // If not a promise, wait a bit for streaming to complete
        setTimeout(() => {
          clearTimeout(timer);
          resolve({
            name: test.name,
            status: 'success',
            output: responseStream.getOutput()
          });
        }, 5000);
      }
    } catch (error) {
      clearTimeout(timer);
      resolve({
        name: test.name,
        status: 'error',
        output: responseStream.getOutput(),
        error: error.message
      });
    }
  });
}

// Environment check
function checkEnvironment() {
  console.log('=== Environment Check ===');
  
  const requiredVars = [
    'GRAFANA_URL',
    'GRAFANA_API_KEY', 
    'CLICKHOUSE_HOST',
    'CLICKHOUSE_USER',
    'AWS_REGION'
  ];
  
  const missing = requiredVars.filter(var_name => !process.env[var_name]);
  
  if (missing.length > 0) {
    console.error('Missing required environment variables:', missing);
    console.error('Please copy .env.example to .env.local and fill in the values');
    return false;
  }
  
  console.log('✅ All required environment variables are set');
  
  // Check if Claude CLI is available
  try {
    const result = spawn('claude', ['--version'], { stdio: 'pipe' });
    console.log('✅ Claude CLI found');
  } catch (error) {
    console.warn('⚠️  Claude CLI not found in PATH. Install with: npm install -g @anthropic-ai/claude-code');
  }
  
  // Check if Python MCP packages are available
  try {
    const result = spawn('python', ['-c', 'import mcp; print("MCP available")'], { stdio: 'pipe' });
    console.log('✅ Python MCP framework available');
  } catch (error) {
    console.warn('⚠️  Python MCP not found. Run: pip install mcp');
  }
  
  return true;
}

// Main test runner
async function runAllTests() {
  console.log('Starting Lambda Function Tests\n');
  
  if (!checkEnvironment()) {
    process.exit(1);
  }
  
  console.log(`\nRunning ${tests.length} tests...\n`);
  
  const results = [];
  
  for (const test of tests) {
    const result = await runTest(test);
    results.push(result);
    
    console.log(`\nTest "${result.name}" completed with status: ${result.status}`);
    if (result.error) {
      console.error(`Error: ${result.error}`);
    }
    
    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Summary
  console.log('\n=== Test Summary ===');
  const successful = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'error').length;
  const timedOut = results.filter(r => r.status === 'timeout').length;
  
  console.log(`Total tests: ${results.length}`);
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  console.log(`Timed out: ${timedOut}`);
  
  results.forEach(result => {
    console.log(`\n${result.name}: ${result.status}`);
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
  });
  
  return results;
}

// Export for use in other test files
module.exports = {
  runTest,
  runAllTests,
  createTestEvent,
  createMockContext,
  MockResponseStream
};

// Run tests if this file is executed directly
if (require.main === module) {
  runAllTests().then(results => {
    const hasFailures = results.some(r => r.status !== 'success');
    process.exit(hasFailures ? 1 : 0);
  }).catch(error => {
    console.error('Test runner failed:', error);
    process.exit(1);
  });
}
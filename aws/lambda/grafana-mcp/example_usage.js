#!/usr/bin/env node

/**
 * Example usage of the Grafana MCP Lambda with session management
 * 
 * This demonstrates how to:
 * 1. Send queries with user UUID for session management
 * 2. Handle streaming responses
 * 3. Maintain persistent context across requests
 */

const https = require('https');
const { URL } = require('url');
const { randomUUID } = require('crypto');

// Replace with your actual Lambda function URL from terraform output
const LAMBDA_URL = 'https://your-lambda-url.lambda-url.us-east-1.on.aws/';

/**
 * Send a query to the Lambda function with streaming response handling
 */
async function sendQuery(query, userUuid) {
  return new Promise((resolve, reject) => {
    const url = new URL(LAMBDA_URL);
    const postData = JSON.stringify({
      query: query,
      userUuid: userUuid
    });

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    console.log(`\n🚀 Sending query for user ${userUuid}:`);
    console.log(`📝 Query: ${query}`);
    console.log('\n📨 Response:');
    console.log('─'.repeat(50));

    const req = https.request(options, (res) => {
      let fullResponse = '';

      // Handle streaming response
      res.on('data', (chunk) => {
        const chunkStr = chunk.toString();
        process.stdout.write(chunkStr); // Stream to console
        fullResponse += chunkStr;
      });

      res.on('end', () => {
        console.log('\n' + '─'.repeat(50));
        console.log('✅ Response complete\n');
        resolve(fullResponse);
      });
    });

    req.on('error', (error) => {
      console.error('❌ Request error:', error);
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Demonstrate session persistence across multiple requests
 */
async function demonstrateSessionPersistence() {
  // Generate a unique user ID for this demonstration
  const userUuid = randomUUID();
  
  console.log('🎯 Grafana MCP Lambda Session Management Demo');
  console.log('=' .repeat(60));
  console.log(`👤 User UUID: ${userUuid}`);

  try {
    // First request - establish context
    await sendQuery(
      "Hello! I'm working on monitoring dashboards. Can you help me understand what ClickHouse tables are available?",
      userUuid
    );

    // Wait a moment between requests
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Second request - should remember previous context
    await sendQuery(
      "Based on the tables you just showed me, can you create a Grafana dashboard that shows the top 10 most frequent queries?",
      userUuid
    );

    // Wait a moment between requests
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Third request - continue the conversation
    await sendQuery(
      "Now add a panel showing query execution time trends over the last 24 hours",
      userUuid
    );

  } catch (error) {
    console.error('❌ Demo failed:', error);
  }
}

/**
 * Demonstrate multiple concurrent users with isolated sessions
 */
async function demonstrateConcurrentUsers() {
  console.log('\n🔄 Testing Concurrent Users with Session Isolation');
  console.log('=' .repeat(60));

  const user1 = randomUUID();
  const user2 = randomUUID();

  // Start both users simultaneously
  const promises = [
    sendQuery("I want to monitor CPU usage. What should I do first?", user1),
    sendQuery("I need to track database query performance. Where do I start?", user2)
  ];

  try {
    await Promise.all(promises);
    console.log('✅ Both users completed successfully with isolated sessions');
  } catch (error) {
    console.error('❌ Concurrent user test failed:', error);
  }
}

/**
 * Test specific MCP tool functionality
 */
async function testMCPTools() {
  const userUuid = randomUUID();
  
  console.log('\n🛠️  Testing MCP Tool Integration');
  console.log('=' .repeat(60));

  const queries = [
    "Show me the schema for the oss_ci_benchmark_v3 table",
    "Run a query to get the top 5 most recent benchmark results",
    "Create a simple Grafana dashboard with these results"
  ];

  for (const query of queries) {
    try {
      await sendQuery(query, userUuid);
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (error) {
      console.error(`❌ Failed query: ${query}`, error);
    }
  }
}

/**
 * Main demo function
 */
async function main() {
  if (LAMBDA_URL.includes('your-lambda-url')) {
    console.error('❌ Please update LAMBDA_URL with your actual Lambda function URL');
    console.log('💡 Get it with: terraform output lambda_function_url');
    process.exit(1);
  }

  console.log('🚀 Starting Grafana MCP Lambda Demo');
  console.log(`🔗 Lambda URL: ${LAMBDA_URL}`);
  
  // Run the demos
  await demonstrateSessionPersistence();
  await demonstrateConcurrentUsers();
  await testMCPTools();
  
  console.log('\n🎉 Demo completed!');
  console.log('\n📊 Check your S3 bucket for stored sessions:');
  console.log('aws s3 ls s3://$(terraform output -raw session_bucket_name)/sessions/ --recursive');
}

// Handle command line arguments
if (process.argv.length > 2) {
  const query = process.argv.slice(2).join(' ');
  const userUuid = process.env.USER_UUID || randomUUID();
  
  sendQuery(query, userUuid).catch(console.error);
} else {
  main().catch(console.error);
}

module.exports = {
  sendQuery,
  demonstrateSessionPersistence,
  demonstrateConcurrentUsers,
  testMCPTools
};
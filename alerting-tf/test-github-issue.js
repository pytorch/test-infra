#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Load configuration
function loadConfig() {
  const configPath = './github-app-config.json';
  if (!fs.existsSync(configPath)) {
    console.error('❌ Config file not found. Please create github-app-config.json from the template.');
    console.error('   Copy github-app-config.json.template to github-app-config.json and fill in your values.');
    process.exit(1);
  }
  
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  // Validate required fields
  if (!config.github_app_id) {
    console.error('❌ github_app_id is required in config file');
    process.exit(1);
  }
  
  if (!config.github_app_key_base64) {
    console.error('❌ github_app_key_base64 is required in config file');
    process.exit(1);
  }
  
  if (!config.target_repo) {
    console.error('❌ target_repo is required in config file');
    process.exit(1);
  }
  
  // Decode base64 private key
  try {
    config.private_key = Buffer.from(config.github_app_key_base64, 'base64').toString('utf8');
  } catch (error) {
    console.error('❌ Failed to decode base64 private key:', error.message);
    process.exit(1);
  }
  
  return config;
}

// Create JWT for GitHub App authentication
function createAppJWT(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 30, // issued 30 seconds ago (for clock skew)
    exp: now + (9 * 60), // expires in 9 minutes
    iss: appId
  };
  
  return jwt.sign(payload, privateKey, { algorithm: 'RS256' });
}

// Get installation token for the repository
async function getInstallationToken(config) {
  const [owner, repo] = config.target_repo.split('/');
  const appJWT = createAppJWT(config.github_app_id, config.private_key);
  
  console.log('🔍 Finding GitHub App installation...');
  
  // Get installation ID
  const installationResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
    headers: {
      'Authorization': `Bearer ${appJWT}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pytorch-alerting-test'
    }
  });
  
  if (installationResponse.status === 404) {
    console.error(`❌ GitHub App is not installed on ${config.target_repo}`);
    console.error('   Please install the GitHub App on the repository first.');
    process.exit(1);
  }
  
  if (!installationResponse.ok) {
    const errorText = await installationResponse.text();
    console.error(`❌ Failed to get installation: ${installationResponse.status}`);
    console.error(`   ${errorText}`);
    process.exit(1);
  }
  
  const installation = await installationResponse.json();
  console.log(`✅ Found installation ID: ${installation.id}`);
  
  // Get installation token
  console.log('🔑 Getting installation access token...');
  const tokenResponse = await fetch(`https://api.github.com/app/installations/${installation.id}/access_tokens`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${appJWT}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pytorch-alerting-test'
    }
  });
  
  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error(`❌ Failed to create installation token: ${tokenResponse.status}`);
    console.error(`   ${errorText}`);
    process.exit(1);
  }
  
  const tokenData = await tokenResponse.json();
  console.log('✅ Got installation access token');
  
  return tokenData.token;
}

// Create a test issue
async function createTestIssue(config, token) {
  const [owner, repo] = config.target_repo.split('/');
  
  const title = `[ALERT][TEST] GitHub App Authentication Test - ${new Date().toISOString()}`;
  const body = `# GitHub App Authentication Test

This is a test issue created to verify that the GitHub App authentication is working correctly.

**Test Details:**
- Created: ${new Date().toISOString()}
- App ID: ${config.github_app_id}
- Repository: ${config.target_repo}
- Script: test-github-issue.js

**Next Steps:**
- ✅ Authentication successful
- ✅ Issue creation successful
- 🔄 Ready to integrate with AWS Secrets Manager
- 🔄 Ready to update Lambda function

This issue can be closed once the test is confirmed successful.`;

  console.log('📝 Creating test issue...');
  
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pytorch-alerting-test',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: title,
      body: body,
      labels: ['test', 'alerting']
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ Failed to create issue: ${response.status}`);
    console.error(`   ${errorText}`);
    process.exit(1);
  }
  
  const issue = await response.json();
  console.log(`✅ Created test issue #${issue.number}`);
  console.log(`   URL: ${issue.html_url}`);
  
  return issue;
}

// Main function
async function main() {
  console.log('🚀 Starting GitHub App authentication test...\n');
  
  try {
    const config = loadConfig();
    console.log(`📋 Config loaded:`);
    console.log(`   App ID: ${config.github_app_id}`);
    console.log(`   Target repo: ${config.target_repo}`);
    console.log(`   Private key: base64 encoded (${config.github_app_key_base64.length} chars)\n`);
    
    const token = await getInstallationToken(config);
    const issue = await createTestIssue(config, token);
    
    console.log('\n🎉 Test completed successfully!');
    console.log(`   Issue created: #${issue.number}`);
    console.log(`   URL: ${issue.html_url}`);
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}
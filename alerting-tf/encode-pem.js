#!/usr/bin/env node

const fs = require('fs');

function encodePemToBase64(pemFilePath) {
  if (!fs.existsSync(pemFilePath)) {
    console.error(`❌ PEM file not found: ${pemFilePath}`);
    process.exit(1);
  }
  
  const pemContent = fs.readFileSync(pemFilePath, 'utf8');
  const base64Encoded = Buffer.from(pemContent).toString('base64');
  
  console.log('✅ PEM file encoded to base64:');
  console.log('');
  console.log('Copy this value to your github-app-config.json file:');
  console.log('');
  console.log(base64Encoded);
  console.log('');
  console.log('🔧 This is the exact format your Lambda expects in AWS Secrets Manager:');
  console.log('');
  console.log(JSON.stringify({
    "github_app_id": "1920175", 
    "github_app_key_base64": base64Encoded
  }, null, 2));
}

// Usage
const pemFile = process.argv[2];
if (!pemFile) {
  console.log('Usage: node encode-pem.js <path-to-pem-file>');
  console.log('Example: node encode-pem.js ./github-app-private-key.pem');
  process.exit(1);
}

encodePemToBase64(pemFile);
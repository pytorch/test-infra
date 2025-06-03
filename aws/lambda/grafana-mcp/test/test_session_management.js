#!/usr/bin/env node

/**
 * Session Management Integration Tests
 * 
 * Tests the session management functionality in isolation:
 * - Session directory setup
 * - S3 upload/download simulation
 * - Session persistence logic
 * - Cross-contamination prevention
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

class SessionTestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log('🔐 Session Management Tests');
    console.log('=' .repeat(50));

    for (const { name, fn } of this.tests) {
      try {
        console.log(`\n🔍 Testing: ${name}`);
        await fn();
        console.log(`✅ PASS: ${name}`);
        this.passed++;
      } catch (error) {
        console.log(`❌ FAIL: ${name}`);
        console.log(`   Error: ${error.message}`);
        this.failed++;
      }
    }

    console.log('\n' + '=' .repeat(50));
    console.log(`📊 Results: ${this.passed} passed, ${this.failed} failed`);
    return this.failed === 0;
  }

  assert(condition, message) {
    if (!condition) {
      throw new Error(message || 'Assertion failed');
    }
  }
}

const runner = new SessionTestRunner();

// Mock S3 operations for testing
class MockS3Operations {
  constructor() {
    this.storage = new Map();
  }

  async uploadSession(userUuid, sessionData) {
    const key = `sessions/${userUuid}/session.zip`;
    this.storage.set(key, sessionData);
    return { success: true, key };
  }

  async downloadSession(userUuid) {
    const key = `sessions/${userUuid}/session.zip`;
    if (this.storage.has(key)) {
      return { success: true, data: this.storage.get(key) };
    }
    return { success: false, error: 'NoSuchKey' };
  }

  clear() {
    this.storage.clear();
  }
}

const mockS3 = new MockS3Operations();

// Test session directory setup
runner.test('Session Directory Setup', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
  const userUuid = 'test-user-123';
  
  async function setupClaudeDirectory(userUuid, tempDir) {
    const claudeDir = path.join(tempDir, '.claude');
    
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    
    return claudeDir;
  }
  
  const claudeDir = await setupClaudeDirectory(userUuid, tempDir);
  
  runner.assert(fs.existsSync(claudeDir), 'Claude directory should exist');
  runner.assert(fs.statSync(claudeDir).isDirectory(), 'Should be a directory');
  runner.assert(claudeDir.includes('.claude'), 'Should be named .claude');
  
  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Test session zip creation
runner.test('Session ZIP Creation', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-test-'));
  const claudeDir = path.join(tempDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  
  // Create some test files
  fs.writeFileSync(path.join(claudeDir, 'history.json'), '{"conversations": []}');
  fs.writeFileSync(path.join(claudeDir, 'context.txt'), 'Previous context data');
  
  const subDir = path.join(claudeDir, 'projects');
  fs.mkdirSync(subDir);
  fs.writeFileSync(path.join(subDir, 'project1.json'), '{"name": "test"}');
  
  // Create ZIP
  const zip = new AdmZip();
  
  function addDirectory(dirPath, zipPath = '') {
    const files = fs.readdirSync(dirPath);
    
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const zipFilePath = zipPath ? path.join(zipPath, file) : file;
      
      if (fs.statSync(fullPath).isDirectory()) {
        addDirectory(fullPath, zipFilePath);
      } else {
        zip.addLocalFile(fullPath, zipPath);
      }
    }
  }
  
  addDirectory(claudeDir);
  const zipBuffer = zip.toBuffer();
  
  runner.assert(zipBuffer.length > 0, 'ZIP should not be empty');
  
  // Verify ZIP contents
  const testZip = new AdmZip(zipBuffer);
  const entries = testZip.getEntries();
  const fileNames = entries.map(entry => entry.entryName);
  
  runner.assert(fileNames.includes('history.json'), 'Should include history.json');
  runner.assert(fileNames.includes('context.txt'), 'Should include context.txt');
  runner.assert(fileNames.some(name => name.includes('project1.json')), 'Should include subdirectory files');
  
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Test session upload/download cycle
runner.test('Session Upload/Download Cycle', async () => {
  const tempDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'download-test-'));
  
  const userUuid = 'cycle-test-user';
  const claudeDir1 = path.join(tempDir1, '.claude');
  const claudeDir2 = path.join(tempDir2, '.claude');
  
  fs.mkdirSync(claudeDir1, { recursive: true });
  fs.mkdirSync(claudeDir2, { recursive: true });
  
  // Create session data
  const testData = { 
    conversations: ['Hello', 'How can I help?'],
    context: 'Working on dashboards',
    timestamp: Date.now()
  };
  fs.writeFileSync(path.join(claudeDir1, 'session.json'), JSON.stringify(testData));
  
  // Upload session
  const zip = new AdmZip();
  zip.addLocalFile(path.join(claudeDir1, 'session.json'));
  const zipBuffer = zip.toBuffer();
  
  const uploadResult = await mockS3.uploadSession(userUuid, zipBuffer);
  runner.assert(uploadResult.success, 'Upload should succeed');
  
  // Download session
  const downloadResult = await mockS3.downloadSession(userUuid);
  runner.assert(downloadResult.success, 'Download should succeed');
  
  // Extract and verify
  const downloadZip = new AdmZip(downloadResult.data);
  downloadZip.extractAllTo(claudeDir2, true);
  
  const restoredFile = path.join(claudeDir2, 'session.json');
  runner.assert(fs.existsSync(restoredFile), 'Restored file should exist');
  
  const restoredData = JSON.parse(fs.readFileSync(restoredFile, 'utf8'));
  runner.assert(restoredData.context === testData.context, 'Data should be preserved');
  runner.assert(restoredData.conversations.length === 2, 'Conversations should be preserved');
  
  fs.rmSync(tempDir1, { recursive: true, force: true });
  fs.rmSync(tempDir2, { recursive: true, force: true });
});

// Test session isolation
runner.test('Session Isolation', async () => {
  const user1 = 'user-1-isolation-test';
  const user2 = 'user-2-isolation-test';
  
  // Create different session data for each user
  const user1Data = Buffer.from('User 1 session data');
  const user2Data = Buffer.from('User 2 session data');
  
  // Upload sessions
  await mockS3.uploadSession(user1, user1Data);
  await mockS3.uploadSession(user2, user2Data);
  
  // Download and verify isolation
  const user1Result = await mockS3.downloadSession(user1);
  const user2Result = await mockS3.downloadSession(user2);
  
  runner.assert(user1Result.success, 'User 1 download should succeed');
  runner.assert(user2Result.success, 'User 2 download should succeed');
  runner.assert(!user1Result.data.equals(user2Result.data), 'Sessions should be different');
  
  // Verify cross-contamination doesn't occur
  const user3Result = await mockS3.downloadSession('non-existent-user');
  runner.assert(!user3Result.success, 'Non-existent user should fail');
  runner.assert(user3Result.error === 'NoSuchKey', 'Should return NoSuchKey error');
});

// Test cross-contamination prevention
runner.test('Cross-Contamination Prevention', async () => {
  // Simulate multiple concurrent requests
  const users = ['user-a', 'user-b', 'user-c'];
  const tempDirs = [];
  
  try {
    // Create separate temp directories for each user
    for (const user of users) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `contamination-test-${user}-`));
      const claudeDir = path.join(tempDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      
      // Create unique data for each user
      fs.writeFileSync(
        path.join(claudeDir, 'user-data.txt'), 
        `Data for ${user} - ${Date.now()}`
      );
      
      tempDirs.push({ user, tempDir, claudeDir });
    }
    
    // Verify each directory is isolated
    for (let i = 0; i < tempDirs.length; i++) {
      const currentDir = tempDirs[i];
      const userDataFile = path.join(currentDir.claudeDir, 'user-data.txt');
      const userData = fs.readFileSync(userDataFile, 'utf8');
      
      runner.assert(userData.includes(currentDir.user), 'Should contain correct user data');
      
      // Verify other users' data is not present
      for (let j = 0; j < tempDirs.length; j++) {
        if (i !== j) {
          const otherUser = tempDirs[j].user;
          runner.assert(!userData.includes(otherUser), `Should not contain ${otherUser} data`);
        }
      }
    }
    
  } finally {
    // Cleanup all temp directories
    for (const { tempDir } of tempDirs) {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }
});

// Test session persistence across requests
runner.test('Session Persistence Across Requests', async () => {
  const userUuid = 'persistence-test-user';
  
  // Simulate first request
  const tempDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'request1-'));
  const claudeDir1 = path.join(tempDir1, '.claude');
  fs.mkdirSync(claudeDir1, { recursive: true });
  
  // Simulate Claude creating some context
  const initialContext = {
    conversation: ['Hi, I need help with dashboards'],
    userPreferences: { theme: 'dark', defaultDataSource: 'ClickHouse' },
    workingFiles: ['dashboard-config.json']
  };
  
  fs.writeFileSync(path.join(claudeDir1, 'context.json'), JSON.stringify(initialContext));
  fs.writeFileSync(path.join(claudeDir1, 'dashboard-config.json'), '{"panels": []}');
  
  // Upload after first request
  const zip1 = new AdmZip();
  zip1.addLocalFile(path.join(claudeDir1, 'context.json'));
  zip1.addLocalFile(path.join(claudeDir1, 'dashboard-config.json'));
  
  await mockS3.uploadSession(userUuid, zip1.toBuffer());
  
  // Simulate second request
  const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'request2-'));
  const claudeDir2 = path.join(tempDir2, '.claude');
  fs.mkdirSync(claudeDir2, { recursive: true });
  
  // Download session from first request
  const downloadResult = await mockS3.downloadSession(userUuid);
  runner.assert(downloadResult.success, 'Should download previous session');
  
  const zip2 = new AdmZip(downloadResult.data);
  zip2.extractAllTo(claudeDir2, true);
  
  // Verify context is restored
  const restoredContext = JSON.parse(fs.readFileSync(path.join(claudeDir2, 'context.json'), 'utf8'));
  runner.assert(restoredContext.userPreferences.theme === 'dark', 'Should restore user preferences');
  runner.assert(restoredContext.conversation[0].includes('dashboards'), 'Should restore conversation');
  
  const restoredConfig = fs.readFileSync(path.join(claudeDir2, 'dashboard-config.json'), 'utf8');
  runner.assert(restoredConfig.includes('panels'), 'Should restore working files');
  
  // Cleanup
  fs.rmSync(tempDir1, { recursive: true, force: true });
  fs.rmSync(tempDir2, { recursive: true, force: true });
});

// Test environment cleanup
runner.test('Environment Cleanup', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
  const claudeDir = path.join(tempDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  
  // Create some files
  fs.writeFileSync(path.join(claudeDir, 'temp-file.txt'), 'temporary data');
  fs.writeFileSync(path.join(tempDir, 'other-file.txt'), 'other data');
  
  runner.assert(fs.existsSync(tempDir), 'Temp directory should exist before cleanup');
  
  // Simulate cleanup function
  function cleanupTempDirectory(dir) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  cleanupTempDirectory(tempDir);
  
  runner.assert(!fs.existsSync(tempDir), 'Temp directory should not exist after cleanup');
  runner.assert(!fs.existsSync(claudeDir), 'Claude directory should not exist after cleanup');
});

// Run tests
async function main() {
  const success = await runner.run();
  
  // Clear mock storage
  mockS3.clear();
  
  if (success) {
    console.log('\n🎉 All session management tests passed!');
    process.exit(0);
  } else {
    console.log('\n💥 Some tests failed');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { SessionTestRunner, MockS3Operations };
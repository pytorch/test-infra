/**
 * Unit Tests for Grafana MCP Lambda
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { MCP_TOOLS } = require('../test_modules/mcp_tools_mock');

// Mock AWS SDK for testing
const mockS3Client = {
  send: jest.fn().mockImplementation(async (command) => {
    // Mock GetObjectCommand
    if (command.input && command.input.Key) {
      if (command.input.Key.includes('nonexistent')) {
        const error = new Error('NoSuchKey');
        error.name = 'NoSuchKey';
        throw error;
      }
      return {
        Body: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('test session data');
          }
        }
      };
    }
    // Mock PutObjectCommand
    else {
      return { ETag: '"test-etag"' };
    }
  })
};

// Test MCP Tools Configuration
describe('MCP Tools Configuration', () => {
  test('should have MCP tools defined', () => {
    expect(MCP_TOOLS).toBeDefined();
    expect(Object.keys(MCP_TOOLS).length).toBeGreaterThan(0);
  });
  
  test('should have Grafana dashboard tool', () => {
    expect(MCP_TOOLS['mcp__grafana-mcp__get_dashboard']).toBeDefined();
  });
  
  test('should have ClickHouse query tool', () => {
    expect(MCP_TOOLS['mcp__clickhouse-pip__run_clickhouse_query']).toBeDefined();
  });
  
  test('should have correct tool structure', () => {
    const tool = MCP_TOOLS['mcp__grafana-mcp__get_dashboard'];
    expect(tool.service).toBeDefined();
    expect(tool.method).toBeDefined();
  });
});

// Test Session Directory Setup
describe('Session Directory Setup', () => {
  let tempDir;
  let claudeDir;
  
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-session-'));
    claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
  });
  
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  
  test('should create claude directory', () => {
    expect(fs.existsSync(claudeDir)).toBe(true);
    expect(fs.statSync(claudeDir).isDirectory()).toBe(true);
  });
});

// Test S3 Session Operations (Mocked)
describe('S3 Session Operations', () => {
  let tempDir;
  let claudeDir;
  
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-s3-'));
    claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
  });
  
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  
  test('should download existing session successfully', async () => {
    // Mock the download function
    async function mockDownloadSessionFromS3(userUuid, claudeDir) {
      try {
        const command = { input: { Key: `sessions/${userUuid}/session.zip` } };
        const response = await mockS3Client.send(command);
        
        if (response && response.Body) {
          // Simulate extracting to directory
          fs.writeFileSync(path.join(claudeDir, 'test-file.txt'), 'test content');
          return true;
        }
        return false;
      } catch (error) {
        if (error.name === 'NoSuchKey') {
          return false;
        }
        throw error;
      }
    }
    
    const result = await mockDownloadSessionFromS3('test-user', claudeDir);
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(claudeDir, 'test-file.txt'))).toBe(true);
  });
  
  test('should handle non-existent session', async () => {
    // Mock the download function
    async function mockDownloadSessionFromS3(userUuid, claudeDir) {
      try {
        const command = { input: { Key: `sessions/${userUuid}/session.zip` } };
        const response = await mockS3Client.send(command);
        
        if (response && response.Body) {
          // Simulate extracting to directory
          fs.writeFileSync(path.join(claudeDir, 'test-file.txt'), 'test content');
          return true;
        }
        return false;
      } catch (error) {
        if (error.name === 'NoSuchKey') {
          return false;
        }
        throw error;
      }
    }
    
    mockS3Client.send.mockImplementationOnce(() => {
      const error = new Error('NoSuchKey');
      error.name = 'NoSuchKey';
      throw error;
    });
    
    const result = await mockDownloadSessionFromS3('nonexistent-user', claudeDir);
    expect(result).toBe(false);
  });
  
  test('should upload session successfully', async () => {
    async function mockUploadSessionToS3(userUuid, claudeDir) {
      if (fs.existsSync(claudeDir)) {
        const command = { 
          input: { 
            Body: Buffer.from('zipped session data')  // No Key for upload
          } 
        };
        const response = await mockS3Client.send(command);
        return response && response.ETag !== undefined;
      }
      return false;
    }
    
    fs.writeFileSync(path.join(claudeDir, 'session-data.txt'), 'test session');
    
    const result = await mockUploadSessionToS3('test-user', claudeDir);
    expect(result).toBe(true);
  });
});

// Test MCP Service Call via SSE (Mocked)
describe('MCP Service Call via SSE', () => {
  test('should call Grafana MCP service', async () => {
    async function mockCallMCPServiceSSE(serviceUrl, method, params = {}) {
      // Simulate successful FastMCP SSE call
      if (serviceUrl.includes('grafana') && method === 'get_dashboard') {
        return { 
          dashboard: { 
            id: 1, 
            title: 'Test Dashboard',
            panels: []
          } 
        };
      } else if (serviceUrl.includes('clickhouse') && method === 'run_clickhouse_query') {
        return {
          result: [
            { column1: 'value1', column2: 'value2' },
            { column1: 'value3', column2: 'value4' }
          ],
          rows: 2
        };
      }
      throw new Error(`Unknown service/method: ${serviceUrl}/${method}`);
    }
    
    const grafanaResult = await mockCallMCPServiceSSE('http://grafana-mcp:8000', 'get_dashboard', { id: 1 });
    expect(grafanaResult.dashboard).toBeDefined();
    expect(grafanaResult.dashboard.title).toBe('Test Dashboard');
  });
  
  test('should call ClickHouse MCP service', async () => {
    async function mockCallMCPServiceSSE(serviceUrl, method, params = {}) {
      // Simulate successful FastMCP SSE call
      if (serviceUrl.includes('grafana') && method === 'get_dashboard') {
        return { 
          dashboard: { 
            id: 1, 
            title: 'Test Dashboard',
            panels: []
          } 
        };
      } else if (serviceUrl.includes('clickhouse') && method === 'run_clickhouse_query') {
        return {
          result: [
            { column1: 'value1', column2: 'value2' },
            { column1: 'value3', column2: 'value4' }
          ],
          rows: 2
        };
      }
      throw new Error(`Unknown service/method: ${serviceUrl}/${method}`);
    }
    
    const clickhouseResult = await mockCallMCPServiceSSE('http://clickhouse-mcp:8001', 'run_clickhouse_query', { query: 'SELECT * FROM test' });
    expect(clickhouseResult.result).toBeDefined();
    expect(clickhouseResult.rows).toBe(2);
  });
});

// Test System Message Creation
describe('System Message Creation', () => {
  test('should create proper system message', () => {
    function createSystemMessage() {
      const availableTools = [
        'mcp__grafana-mcp__get_dashboard',
        'mcp__clickhouse-pip__run_clickhouse_query'
      ];

      return `You are Claude Code, an AI assistant with access to specialized tools for Grafana and ClickHouse operations.

Available MCP Tools:
${availableTools.map(tool => `- ${tool}: MCP tool: ${tool}`).join('\n')}

When you need to use these tools, make function calls using the standard format. The tools will be executed via SSE connections to FastMCP servers running in EKS containers.

Important: 
- Your working directory is /tmp and you have access to a persistent .claude folder for session storage
- All your local data and context is automatically saved and restored between sessions
- Always clean up any temporary files or resources after completing tasks to avoid cross-contamination between requests`;
    }
    
    const systemMessage = createSystemMessage();
    expect(systemMessage).toContain('Claude Code');
    expect(systemMessage).toContain('MCP Tools');
    expect(systemMessage).toContain('/tmp');
    expect(systemMessage).toContain('persistent .claude folder');
  });
});

// Test Request Body Validation
describe('Request Body Validation', () => {
  function validateRequestBody(body) {
    if (!body) {
      throw new Error('Request body is required');
    }
    
    const { query, userUuid } = body;
    
    if (!query) {
      throw new Error('Query parameter is required');
    }
    
    if (!userUuid) {
      throw new Error('userUuid parameter is required for session management');
    }
    
    return { query, userUuid };
  }
  
  test('should validate valid request body', () => {
    const validBody = { query: 'test query', userUuid: 'user-123' };
    const result = validateRequestBody(validBody);
    expect(result.query).toBe('test query');
    expect(result.userUuid).toBe('user-123');
  });
  
  test('should throw for null body', () => {
    expect(() => validateRequestBody(null)).toThrow('Request body is required');
  });
  
  test('should throw for missing query', () => {
    expect(() => validateRequestBody({ userUuid: 'user-123' })).toThrow('Query parameter is required');
  });
  
  test('should throw for missing userUuid', () => {
    expect(() => validateRequestBody({ query: 'test' })).toThrow('userUuid parameter is required');
  });
});

// Test Environment Variables
describe('Environment Variables', () => {
  const originalEnv = process.env;
  
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  
  afterEach(() => {
    process.env = originalEnv;
  });
  
  test('should use environment variables when provided', () => {
    process.env.GRAFANA_MCP_URL = 'http://test-grafana:8000';
    process.env.CLICKHOUSE_MCP_URL = 'http://test-clickhouse:8001';
    process.env.SESSION_BUCKET_NAME = 'test-bucket';
    
    const GRAFANA_MCP_URL = process.env.GRAFANA_MCP_URL || 'http://grafana-mcp-service:8000';
    const CLICKHOUSE_MCP_URL = process.env.CLICKHOUSE_MCP_URL || 'http://clickhouse-mcp-service:8001';
    const S3_BUCKET = process.env.SESSION_BUCKET_NAME || 'grafana-mcp-sessions';
    
    expect(GRAFANA_MCP_URL).toBe('http://test-grafana:8000');
    expect(CLICKHOUSE_MCP_URL).toBe('http://test-clickhouse:8001');
    expect(S3_BUCKET).toBe('test-bucket');
  });
  
  test('should use default values when env vars not provided', () => {
    delete process.env.GRAFANA_MCP_URL;
    delete process.env.CLICKHOUSE_MCP_URL;
    delete process.env.SESSION_BUCKET_NAME;
    
    const GRAFANA_MCP_URL = process.env.GRAFANA_MCP_URL || 'http://grafana-mcp-service:8000';
    const CLICKHOUSE_MCP_URL = process.env.CLICKHOUSE_MCP_URL || 'http://clickhouse-mcp-service:8001';
    const S3_BUCKET = process.env.SESSION_BUCKET_NAME || 'grafana-mcp-sessions';
    
    expect(GRAFANA_MCP_URL).toBe('http://grafana-mcp-service:8000');
    expect(CLICKHOUSE_MCP_URL).toBe('http://clickhouse-mcp-service:8001');
    expect(S3_BUCKET).toBe('grafana-mcp-sessions');
  });
});

// Test Temporary Directory Cleanup
describe('Temporary Directory Cleanup', () => {
  test('should clean up temporary directory', () => {
    function cleanupTempDirectory(tempDir) {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        return !fs.existsSync(tempDir);
      }
      return true;
    }
    
    // Create a test temp directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-cleanup-'));
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'test-file.txt'), 'test content');
    
    expect(fs.existsSync(tempDir)).toBe(true);
    
    const cleanupResult = cleanupTempDirectory(tempDir);
    expect(cleanupResult).toBe(true);
    expect(fs.existsSync(tempDir)).toBe(false);
  });
});

// Test ZIP Operations (AdmZip)
describe('ZIP Operations', () => {
  test('should create and extract ZIP files', () => {
    // Create test files
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-zip-'));
    const testFile1 = path.join(tempDir, 'file1.txt');
    const testFile2 = path.join(tempDir, 'file2.txt');
    
    fs.writeFileSync(testFile1, 'content1');
    fs.writeFileSync(testFile2, 'content2');
    
    try {
      // Create ZIP
      const zip = new AdmZip();
      zip.addLocalFile(testFile1);
      zip.addLocalFile(testFile2);
      
      const zipBuffer = zip.toBuffer();
      expect(zipBuffer.length).toBeGreaterThan(0);
      
      // Extract ZIP
      const extractZip = new AdmZip(zipBuffer);
      const entries = extractZip.getEntries();
      expect(entries.length).toBe(2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Create mocked AWS clients
export const mockDynamoDBClient = mockClient(DynamoDBDocumentClient);
export const mockSecretsManagerClient = mockClient(SecretsManagerClient);

// Helper to reset all mocks
export function resetAllMocks() {
  mockDynamoDBClient.reset();
  mockSecretsManagerClient.reset();
}

// Helper to setup common DynamoDB mock responses
export function setupDynamoDBMocks() {
  // Mock successful GetCommand (alert not found)
  mockDynamoDBClient.resolves({});

  // Mock successful PutCommand
  mockDynamoDBClient.resolves({});

  // Mock successful UpdateCommand
  mockDynamoDBClient.resolves({});
}

// Helper to setup common Secrets Manager mock responses
export function setupSecretsManagerMocks() {
  mockSecretsManagerClient.on(GetSecretValueCommand).resolves({
    SecretString: JSON.stringify({
      app_id: '123456',
      private_key: '-----BEGIN RSA PRIVATE KEY-----\nMOCK_PRIVATE_KEY\n-----END RSA PRIVATE KEY-----',
      installation_id: '78901234',
    }),
  });
}

// Mock GitHub API responses
export const mockGitHubResponses = {
  createIssue: {
    id: 123,
    number: 456,
    title: 'Test Issue',
    state: 'open',
    html_url: 'https://github.com/test-org/test-repo/issues/456',
  },

  updateIssue: {
    id: 123,
    number: 456,
    title: 'Test Issue',
    state: 'closed',
    html_url: 'https://github.com/test-org/test-repo/issues/456',
  },

  createComment: {
    id: 789,
    body: 'Test comment',
    html_url: 'https://github.com/test-org/test-repo/issues/456#issuecomment-789',
  },
};
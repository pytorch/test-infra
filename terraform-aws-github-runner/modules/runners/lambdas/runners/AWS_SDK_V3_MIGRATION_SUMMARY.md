# AWS SDK v2 to v3 Migration Summary

## Overview
This document summarizes the changes made to migrate from AWS SDK v2 to v3 in the scale-runners Lambda function.

## Package Changes

### Removed Dependencies
- `aws-sdk: ^2.863.0`

### Added Dependencies
- `@aws-sdk/client-cloudwatch: ^3.0.0`
- `@aws-sdk/client-ec2: ^3.0.0`
- `@aws-sdk/client-kms: ^3.0.0`
- `@aws-sdk/client-secrets-manager: ^3.0.0`
- `@aws-sdk/client-sqs: ^3.0.0`
- `@aws-sdk/client-ssm: ^3.0.0`

## Code Changes

### 1. SecretsManager (gh-auth.ts)
**Before:**
```typescript
import { SecretsManager } from 'aws-sdk';
const secretsManager = new SecretsManager();
const data = await secretsManager.getSecretValue({ SecretId: secretsManagerSecretsId }).promise();
```

**After:**
```typescript
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
const secretsManager = new SecretsManagerClient({});
const data = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretsManagerSecretsId }));
```

### 2. KMS (kms/index.ts)
**Before:**
```typescript
import AWS from 'aws-sdk';
import { KMS } from 'aws-sdk';
AWS.config.update({ region: Config.Instance.awsRegion });
const kms = new KMS();
return kms.decrypt({ CiphertextBlob, KeyId, EncryptionContext }).promise();
```

**After:**
```typescript
import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms';
const kms = new KMSClient({ region: Config.Instance.awsRegion });
return kms.send(new DecryptCommand({ CiphertextBlob, KeyId, EncryptionContext }));
```

### 3. SQS (sqs.ts)
**Before:**
```typescript
import { SQS } from 'aws-sdk';
const sqs = new SQS();
return sqs.sendMessageBatch(sqsPayload).promise();
return sqs.changeMessageVisibilityBatch(parameters).promise();
return sqs.deleteMessageBatch(parameters).promise();
```

**After:**
```typescript
import { 
  SQSClient, 
  SendMessageBatchCommand, 
  ChangeMessageVisibilityBatchCommand, 
  DeleteMessageBatchCommand 
} from '@aws-sdk/client-sqs';
const sqs = new SQSClient({});
return sqs.send(new SendMessageBatchCommand(sqsPayload));
return sqs.send(new ChangeMessageVisibilityBatchCommand(parameters));
return sqs.send(new DeleteMessageBatchCommand(parameters));
```

### 4. CloudWatch (metrics.ts)
**Before:**
```typescript
import { CloudWatch } from 'aws-sdk';
const cloudwatch = new CloudWatch({ region: Config.Instance.awsRegion });
return await this.cloudwatch.putMetricData(metricsReq).promise();
```

**After:**
```typescript
import { CloudWatchClient, PutMetricDataCommand, MetricDatum, StandardUnit } from '@aws-sdk/client-cloudwatch';
const cloudwatch = new CloudWatchClient({ region: Config.Instance.awsRegion });
return await this.cloudwatch.send(new PutMetricDataCommand(metricsReq));
```

### 5. Queue URL Construction (sqs.ts)
**Before:**
```typescript
function getQueueUrl(evt: SQSRecord, sqs: SQS) {
  return sqs.endpoint.href + accountId + '/' + queueName;
}
```

**After:**
```typescript
function getQueueUrl(evt: SQSRecord): string {
  const region = splitARN[3];
  return `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
}
```

## Key Migration Patterns

### 1. Client Instantiation
- **v2**: `new ServiceName(config)`
- **v3**: `new ServiceNameClient(config)`

### 2. API Calls
- **v2**: `service.operation(params).promise()`
- **v3**: `service.send(new OperationCommand(params))`

### 3. Configuration
- **v2**: `AWS.config.update()` for global config
- **v3**: Pass config directly to client constructor

### 4. Type Imports
- **v2**: Import service classes and use namespaced types
- **v3**: Import specific commands and types

## Benefits of Migration

1. **Smaller Bundle Size**: Only import the services you need
2. **Better Tree Shaking**: Unused code is eliminated
3. **TypeScript Support**: Better type safety and IntelliSense
4. **Modern JavaScript**: Uses native Promises, no more `.promise()` calls
5. **Modular Architecture**: Each service is a separate package

## Remaining Work

The migration is partially complete. Additional work needed:

1. **EC2 and SSM Services**: Complete migration in `runners.ts`
2. **Test Files**: Update all test files to use v3 SDK mocks
3. **Type Definitions**: Fix remaining TypeScript compilation errors
4. **Error Handling**: Ensure error handling works with v3 SDK

## Testing

After completing the migration:
1. Run `npm run build` to check for compilation errors
2. Run `npm test` to ensure all tests pass
3. Deploy to a test environment and verify functionality
4. Monitor CloudWatch logs for any runtime errors

## References

- [AWS SDK v3 Migration Guide](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrating-to-v3.html)
- [AWS SDK v3 Documentation](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/) 
Despite the name, this is the lambda used to write GitHub webhook payloads to S3 for syncing by Rockset as mentioned
in https://github.com/pytorch/test-infra/blob/main/torchci/docs/architecture.md

### Deployment

A new version of the lambda can be deployed using `make deploy` and it will be done so automatically by the workflow
`github-status-test-lambda` when a change is committed to main. We have limited capacity for testing this lambda at
the moment, so additional steps are needed to get the new deployed version to prod:

1. After the new version is deployed, `bunnylol cloud fbossci`
2. Go to [github-status-test](https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/github-status-test?tab=versions) and publish a new version of the lambda
   1. Copy the ARN of the new version, i.e. `arn:aws:lambda:us-east-1:308535385114:function:github-status-test:1`
3. Go to [github-status-test](https://us-east-1.console.aws.amazon.com/apigateway/home?region=us-east-1#/apis/jqogootqqe/resources/clc02o/methods/ANY) API Gateway and update the integration request with the new ARN
4. Deploy the API change to the `default` stage (maybe we should call it `prod`)
5. Go back to the lambda [monitoring page](https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/github-status-test?tab=monitoring) to make sure that:
   1. The number of invocations remain the same
   2. The new version shows up in the logs stream indicating that it's not in used. Also Looking into the Cloudwatch log to confirm that there is nothing wrong there
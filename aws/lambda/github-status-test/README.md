Despite the name, this is the lambda used to write GitHub webhook payloads to S3 for syncing by Rockset as mentioned
in https://github.com/pytorch/test-infra/blob/main/torchci/docs/architecture.md

### Deployment

A new version of the lambda can be deployed using `make deploy` and it will be done so automatically by the workflow
`github-status-test-lambda` when a change is committed to main. We have limited capacity for testing this lambda at
the moment, so additional verification steps are needed to get the new deployed version to prod. More tests and guardrails
can be added later to make the deployment fully automated, but it's kind of low priority because this lambda has rarely
been updated.

#### Using AWS web console

1. After the new version is deployed, `bunnylol cloud fbossci`
2. Go to [github-status-test](https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/github-status-test?tab=versions) and publish a new version of the lambda (click on Actions->`Publish New Version`)
    1. Copy the ARN of the new version, i.e. `arn:aws:lambda:us-east-1:308535385114:function:github-status-test:1`
3. Go to [github-status-test](https://us-east-1.console.aws.amazon.com/apigateway/home?region=us-east-1#/apis/jqogootqqe/resources/clc02o/methods/ANY) API Gateway and update the integration request with the new ARN
4. Deploy the API change to the `default` stage (maybe we should call it `prod`)
5. Go back to the lambda [monitoring page](https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/github-status-test?tab=monitoring) to make sure that:
   1. The number of invocations remain the same
   2. The new version shows up in the logs stream indicating that it's not in used. Also look into the Cloudwatch log to confirm that there is nothing wrong there

#### Using awscli

If you prefer awscli, here are the step to achieve the same thing:

1. Run `aws lambda publish-version --function-name github-status-test` to publish the new version. The new ARN will be listed under `FunctionArn` in the returning JSON
2. Run `aws apigateway get-integration --rest-api-id jqogootqqe --resource-id clc02o --http-method ANY` to describe the integration point. Note that the REST api id is `jqogootqqe` and the integration id is `clc02o`
```
{
    "type": "AWS_PROXY",
    "httpMethod": "POST",
    "uri": "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:308535385114:function:github-status-test:1/invocations",
    "passthroughBehavior": "WHEN_NO_MATCH",
    "contentHandling": "CONVERT_TO_TEXT",
    "timeoutInMillis": 29000,
    "cacheNamespace": "clc02o",
    "cacheKeyParameters": [],
    "integrationResponses": {
        "200": {
            "statusCode": "200",
            "selectionPattern": ".*"
        }
    }
}
```
3. Run `aws apigateway put-integration --rest-api-id jqogootqqe --resource-id clc02o --http-method ANY --type AWS_PROXY --integration-http-method POST --uri arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/<LAMBDA ARN>/invocations` to update the integration to point to the new lambda version
4. Run `aws apigateway create-deployment --rest-api-id jqogootqqe --stage-name default` to deploy the API change to the `default` stage, which is actually `prod`
5. Go back to the lambda [monitoring page](https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/github-status-test?tab=monitoring) to make sure that:
   1. The number of invocations remain the same
   2. The new version shows up in the logs stream indicating that it's not in used. Also look into the Cloudwatch log to confirm that there is nothing wrong there

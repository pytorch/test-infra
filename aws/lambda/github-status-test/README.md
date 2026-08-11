Despite the name, this is the lambda used to write GitHub webhook payloads to S3 as mentioned
in https://github.com/pytorch/test-infra/blob/main/torchci/docs/architecture.md

### GitHub credentials

Job logs are downloaded with a GitHub App installation token, falling back to the `GITHUB_TOKENS`
PAT pool when the app is rate limited, rejected, or not installed on the repo's owner.

| Env var | Required | Purpose |
| --- | --- | --- |
| `GITHUB_APP_ID` | no | App id used to mint installation tokens (e.g. `4550824`, `pytorch-bot-preview`) |
| `GITHUB_APP_PRIVATE_KEY` | no | The app's private key, base64-encoded PEM (same encoding torchci uses) |
| `GITHUB_TOKENS` | yes | Comma-separated PAT pool, used as the fallback and when no app is configured |

With both app vars unset the lambda behaves exactly as before and only uses `GITHUB_TOKENS`, so
the app can be rolled back by clearing the env vars — no code change or redeploy needed.

Notes on the app path:

- Installation tokens last an hour and are cached per repo owner in module scope, so a warm
  invocation reuses one rather than minting a token per job.
- The app's rate limit is per installation. `pytorch` is enterprise-owned, so its installation
  gets 15,000 requests/hour, independent of any other app's quota. Use a dedicated app rather
  than the shared `pytorch-bot` installation, whose quota Dr. CI and the HUD already draw on.
- Repos outside the installation (e.g. `vllm-project/vllm`) resolve to no installation and go
  straight to the PAT pool; that negative result is cached briefly to avoid a lookup per job.
- Downloading job logs is documented as needing the `actions: read` permission. It currently
  works without it because pytorch repos are public, but the permission should be granted so the
  dependency is explicit and private repos keep working.

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

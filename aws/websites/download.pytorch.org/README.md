Contains CloudFront functions

To deploy the AWS:

1. Upload it to CloudFront using
   ```
   aws cloudfront update-function --name pep503_whl_redirect --function-code fileb://pep503_whl_redirect.js
   ```

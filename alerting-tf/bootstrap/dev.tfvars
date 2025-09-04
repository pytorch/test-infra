# Backend (S3 + DynamoDB) for Terraform state — shared for dev/prod
# Edit these before running bootstrap.sh
aws_region     = "us-west-2"
bucket_name    = "tf-state-alerting-pytorch-org-dev" # must be globally unique
env            = "dev"

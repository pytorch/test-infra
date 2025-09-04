Bootstrap Terraform backend resources per environment and generate backend HCL.

Creates:
- S3 bucket for Terraform state (versioned, SSE-S3, public blocked)
- DynamoDB table for state locking (`LockID` hash key)

Usage
1) Create and edit a `<env>.tfvars` file in this directory for each env you want to support with:
   - `aws_region = "<region>"`
   - `bucket_name = "<globally-unique-name>"`
   - `env  = "<env>"`
2) Run terraform to bootstrap:
   - `cd alerting-tf/bootstrap && terraform apply -var-file="<env>.tfvars"`
   

- Create these files in alerting-tf/infra (fill bucket/table names outputted by the terraform commands):
  backend-<env>.hcl
    bucket         = "<bucket name>"
    key            = "env/<env>/alerting/terraform.tfstate"
    region         = "<region>"
    dynamodb_table = "<table name>"
    encrypt        = true

- Initialize infra per env (or use Make targets):
  ```
  cd alerting-tf/infra
  terraform init -reconfigure -backend-config=backend-<env>.hcl
  # whatever other tf commands you want to run now
  ```
  
  Makefile commands exist for common dev and prod envs commands:
  make aws-apply-dev   
  make aws-apply-prod  

Notes
- Buckets must be globally unique across AWS.


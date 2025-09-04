bucket         = "tf-state-alerting-pytorch-org-prod"
key            = "env/prod/alerting/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "tflock-alerting-prod"
encrypt        = true


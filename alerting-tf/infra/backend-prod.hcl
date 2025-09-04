bucket         = "tf-state-alerting-pt-prod"
key            = "env/prod/alerting/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "tflock-alerting-prod"
encrypt        = true


terraform {
  backend "s3" {
    bucket         = "terraform-gpu-devservers"
    key            = "runners/terraform.tfstate"
    region         = "us-east-2"
    dynamodb_table = "tfstate-lock-gpu-devservers"
  }
}


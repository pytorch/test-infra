# Squid Cached Proxy

Squid Cached Proxy is a transparent egress proxy we use in pytorch CI to
cache common download requests.

# Cache policy

```
refresh_pattern -i .(7z|deb|rpm|exe|zip|tar|tgz|gz|ram|rar|bin|tiff)$ 1440 80% 2880
```

It uses the standard squid refresh_pattern for cache requests. In our setup, we tried
to cache at least (1440 minutes - 1 day) and at max (2880 minutes - 2 days), with
last-modified factor 80%. Please refer to `squid/user-data.sh` for details.

See doc here http://www.squid-cache.org/Doc/config/refresh_pattern/


# Deployment

```
# Prepare and validation
terraform init
terraform fmt && terraform validate

# Deployment is manual
terraform plan -var "aws_key_name=squid-key-pair" -var "vpc_id=vpc-xxxxxxxx"
terraform apply -var "aws_key_name=squid-key-pair" -var "vpc_id=vpc-xxxxxxxx"
```

The terraform has instance refresh built in, so whenever there's a change, `terraform apply` can
deploy those changes, including changes in `squid/user-data.sh`.

- Get the secrets from https://console.aws.amazon.com/secretsmanager/home?region=us-east-1#!/secret?name=squid-proxy-vars
- Import key-pair by `ssh-add -K ~/.ssh/squid-key-pair.pem`
- Run `terraform apply -var "aws_key_name=squid-key-pair" -var "vpc_id=vpc-xxxxxxxx"`

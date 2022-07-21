# metrics.pytorch.org

This is an App Runner playbook to spin up a Grafana instance pointed to PyTorch's CloudWatch.

0. Configure secrets on `aws console > app runner > services > test-infra-grafana`

1. Pushing a new docker image will trigger the deployment automatically

    ```bash
    aws ecr get-login-password | docker login --username AWS --password-stdin 308535385114.dkr.ecr.us-east-1.amazonaws.com

    docker build -t 308535385114.dkr.ecr.us-east-1.amazonaws.com/test-infra/grafana:latest .
    docker push 308535385114.dkr.ecr.us-east-1.amazonaws.com/test-infra/grafana:latest
    ```

This spins up a Grafana + TimescaleDB stack behind an Nginx reverse proxy for gathering stats about anything and everything related to OSS PRs / CI in PyTorch. This is intended to be deployed at metrics.pytorch.org as follows:

1. Start up an instance with Terraform

    ```bash
    terraform apply -var="key_name=<aws key name>" -var="name=metrics.pytorch.org" -var="type=t2.xlarge" -var="size=50"
    ```

2. Acquire an SSL key and certificate and store them in `privkey.pem` and `fullchain.pem` respectively

3. Run the Ansible playbook to provision the machine

    ```bash
    ansible-playbook -i awsmon, install.yml --extra-vars=@vars.yml --private-key=<aws private key>
    ```
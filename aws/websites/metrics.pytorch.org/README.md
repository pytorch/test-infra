# metrics.pytorch.org

This is a Terraform script + Ansible playbook to spin up a Grafana instance pointed to PyTorch's CloudWatch.

0. Install dependencies

    ```bash
    pip install ansible
    brew tap hashicorp/tap
    brew install hashicorp/tap/terraform
    ```

1. Start up an instance with Terraform

    ```bash
    terraform apply -var="key_name=<aws key name>" -var="name=metrics.pytorch.org" -var="type=t2.xlarge" -var="size=50"
    ```

2. Acquire an SSL key and certificate and store them in `files/privkey.pem` and `files/fullchain.pem` respectively

3. Create a file called `vars.yml` that looks like

    ```yaml
    passwords:
        grafana_admin_username: 123
        grafana_admin: 123
        aws:
            id: 123
            secret: 123

    ssl_filenames:
        key: privkey.pem
        cert: fullchain.pem
    ```

3. Run the Ansible playbook to provision the machine

    ```bash
    ansible-playbook -i awsmon, install.yml --extra-vars=@vars.yml --private-key=<aws private key>
    ```

## Debugging

```bash
# see why containers aren't up
sudo docker stack ps monitoring --no-trunc

# see grafana logs
sudo docker service logs monitoring_grafana --raw

# log into a container
sudo docker ps  # get id
sudo docker exec -it <ID> /bin/bash
```

## Adding a Dashboard

Dashboards are defined via [Grafana's provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/#dashboards). Create a new dashboard in the UI, then export it to JSON and save that to a file in the repo under [`aws/websites/metrics.pytorch.org/files/dashboards`](aws/websites/metrics.pytorch.org/files/dashboards).

Any `.yml` files there will automatically be picked up by Grafana when it restarts.

Steps to add or change grafana dashboards:

- Go to https://metrics.pytorch.org with login
- Edit the dashboards or alerts directly within the dashboard
- Go to the settings page, and save the JSON
- Setup a PR and commit

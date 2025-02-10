# multi-tenant

## A brief warning
Please be aware that running locally ansible or reset_oldest_ebs can be harmful and dangerous. Those operations are destructive and running multiple in parallel can hinder hosts in a bad state, potentially hard to recover. So, if you are planning to do so, please communicate and reach out to teamates to make sure nothing is running in parallel, this includes the CI `.github/workflows/pet-runners-benchmark-spa.yml`.

The recommended approach is to open a PR and test your changes by pushing to the PR, it is safer: keys are already there. Also, other users can see your actions and changes. And more importantly: it should be concurrency protected.

## You can run ansible into all instances by:
```bash
make ansible
```

## You can also, refresh the main EBS volume for the oldest instance by running
```bash
make reset_oldest_ebs
```

## Aditional
To request more instances, I still didn't develop a proper way, but this can be completed by running the script `scrips/create_instance.sh` and then following the additional manual steps that are in a comment inside the script.

The ansible inventory is manually managed (for now) and can be found on `inventory/manual_inventory`, please make sure to keep it up to date, and if instances are deployed in other regions, it will be necessary to update the script `scripts/reset_oldest_ebs.py`

Some notes about dev setup:
* You need ubuntu deep learning AMI (non-pytorch one)
* g4dn.12xlarge as the instance type

Some commands for debug:

```bash
# for checking which cgroups a process is aligned with
systemd-cgls
# logging in as a specific user with systemd enabled
sudo su -l $USER
# status and logs for the service
systemctl status ghad-manager
journalctl -u ghad-manager.service
# full command docker is running for github daemon in a specific user environment (after logging in as that user)
docker ps --all --no-trunc
docker logs ghad-main-shared-instance-container -f
```

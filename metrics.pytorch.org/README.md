
create machines

```bash
terraform apply -var="key_name=driazati2"

export MACHINE=(cat terraform.tfstate | jq --raw-output '.["resources"][0]["instances"] | .[] | .["attributes"]["public_dns"]')

echo "
Host awsmon
    Hostname $MACHINE
    User ubuntu
    IdentityFile ~/Downloads/driazati2.pem
    ControlMaster auto
    ControlPath ~/.ssh/sockets/awsmon
    ControlPersist 600
" >> ~/.ssh/config
```

download this https://github.com/driazati/dotfiles/blob/master/setup.zip

```bash
scp ~/Downloads/setup.zip awsmon:~
```

```bash
python3 setup.zip --skip_conda
```

install stuff

```bash
pip install ansible
ansible-playbook -i inventory.yml install.yml --private-key=~/Downloads/driazati2.pem


sudo docker stack deploy -c /etc/pytorch/docker-compose.yml monitoring
```
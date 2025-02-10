DATE_TAG_NOW := $(shell date +'%Y%m%d%H%M%S')
RESET_OLDEST_EBS_LOG_LEVEL ?= INFO
MAX_SIMULTANEOUS_DRAINING ?= 1

all: ansible reset_oldest_ebs

.PHONY: clean
clean:
	rm -rf inventory/refresh_inventory temp venv

.PHONY: venv
venv: venv/bin/python3

venv/bin/python3:
	python3 -m venv venv
	venv/bin/pip install --upgrade pip
	venv/bin/pip install -r requirements.txt

temp/multi-tenant-gpu-tag:
	mkdir -p temp
	aws ecr describe-images --repository-name multi-tenant-gpu \
		| jq '[.imageDetails[] | (.imageTags // [])[] | select(. != "latest") | select(test("^[0-9]+$$")) | tonumber] | max' \
		| tee temp/multi-tenant-gpu-tag

.PHONY: check-environment-variables-setup-host
check-environment-variables-setup-host:
	if [ -z "$$A100_GH_APP_PK" ] ; then \
		echo "Please set A100_GH_APP_PK environment variable" ; \
		exit 1 ; \
	fi
	if [ -z "$$INSTANCE_LABELS" ] ; then \
		echo "Please set INSTANCE_LABELS environment variable" ; \
		exit 1 ; \
	fi

.PHONY: ansible-setup-host-all
ansible-setup-host-all: venv/bin/python3 temp/multi-tenant-gpu-tag check-environment-variables-setup-host
	venv/bin/ansible-playbook \
		-i inventory/manual_inventory \
		-u ubuntu \
		playbooks/setup-host.yml \
		-vv

.PHONY: ansible-setup-host-refresh-inventory
ansible-setup-host-refresh-inventory: venv/bin/python3 temp/multi-tenant-gpu-tag check-environment-variables-setup-host
	venv/bin/ansible-playbook \
		-i inventory/refresh_inventory \
		-u ubuntu \
		playbooks/setup-host.yml \
		-vv

.PHONY: ansible-restart-refresh-inventory
ansible-restart-refresh-inventory: venv/bin/python3
	venv/bin/ansible-playbook \
		-i inventory/refresh_inventory \
		-u ubuntu \
		playbooks/restart-services.yml \
		-vv

.PHONY: ansible-restart-ghad-refresh-inventory
ansible-restart-ghad-refresh-inventory: venv/bin/python3
	venv/bin/ansible-playbook \
		-i inventory/refresh_inventory \
		-u ubuntu \
		playbooks/restart-ghad-service.yml \
		-vv

.PHONY: reset-oldest-ebs
reset-oldest-ebs: venv/bin/python3
	if [ -z "$(RESET_OLDEST_EBS_INSTANCE_NAME)" ] ; then \
		echo "Please set RESET_OLDEST_EBS_INSTANCE_NAME variable" ; \
		exit 1 ; \
	fi
	if [ -z "$(FORCE_ON_DRAIN_TIMEOUT)" ] ; then \
		echo "Please set FORCE_ON_DRAIN_TIMEOUT variable" ; \
		exit 1 ; \
	fi
	venv/bin/python3 scripts/reset_oldest_ebs.py --logging-level $(RESET_OLDEST_EBS_LOG_LEVEL) --instance-name "$(RESET_OLDEST_EBS_INSTANCE_NAME)" --force-on-drain-timeout "$(FORCE_ON_DRAIN_TIMEOUT)" reset-oldest-ebs

.PHONY: check-last-ebs-connection
check-last-ebs-connection: venv/bin/python3
	if [ -z "$(RESET_OLDEST_EBS_INSTANCE_NAME)" ] ; then \
		echo "Please set RESET_OLDEST_EBS_INSTANCE_NAME environment variable" ; \
		exit 1 ; \
	fi
	venv/bin/python3 scripts/reset_oldest_ebs.py --logging-level $(RESET_OLDEST_EBS_LOG_LEVEL) --instance-name "$(RESET_OLDEST_EBS_INSTANCE_NAME)" check-last-ebs-connection

.PHONY: safely-restart-all-instances
safely-restart-all-instances: venv/bin/python3
	if [ -z "$(INSTANCE_NAME)" ] ; then \
		echo "Please set INSTANCE_NAME environment variable" ; \
		exit 1 ; \
	fi
	venv/bin/python3 scripts/reset_oldest_ebs.py --logging-level $(RESET_OLDEST_EBS_LOG_LEVEL) --instance-name "$(INSTANCE_NAME)" safely-restart-all-instances --max-simultaneous-draining "$(MAX_SIMULTANEOUS_DRAINING)"

.PHONY: docker-build-multi-tenant-gpu
docker-build-multi-tenant-gpu:
	docker build -t multi-tenant-gpu images/multi-tenant-gpu
	docker tag multi-tenant-gpu:latest 308535385114.dkr.ecr.us-east-1.amazonaws.com/multi-tenant-gpu:latest
	docker tag multi-tenant-gpu:latest 308535385114.dkr.ecr.us-east-1.amazonaws.com/multi-tenant-gpu:$(DATE_TAG_NOW)
	docker push 308535385114.dkr.ecr.us-east-1.amazonaws.com/multi-tenant-gpu:latest
	docker push 308535385114.dkr.ecr.us-east-1.amazonaws.com/multi-tenant-gpu:$(DATE_TAG_NOW)

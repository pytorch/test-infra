#!/bin/bash

RUNNER_USER=$1
DOCKER_GROUP_ID=$2
RUNNER_URL=$3
GH_TOKEN=$4
INSTANCE_ID=$5
export RUNNER_UID=$6
INSTANCE_LABEL=$7

if [[ "$#" -ne 7 ]] ; then
    echo "Invalid usage, not going to work"
    exit 1
fi

sudo groupadd -g $DOCKER_GROUP_ID dockerlink
sudo usermod -aG dockerlink runner
sudo useradd $RUNNER_USER --uid 1000 --gid 1000 --groups 1000,2375,docker,docker2,dockerlink --non-unique --shell /bin/bash
sudo usermod -a -G sudo $RUNNER_USER

sudo cp -a /home/runner/. /home/$RUNNER_USER/.
echo "RUNNER_UID=$RUNNER_UID" >> /home/$RUNNER_USER/.env
sudo chown -R 1000:1000 /home/$RUNNER_USER

sudo su - $RUNNER_USER -c "/bin/bash -c './config.sh --url $RUNNER_URL --token $GH_TOKEN --name ${INSTANCE_ID}-${RUNNER_UID} --labels $INSTANCE_LABEL --ephemeral && ./run.sh'"

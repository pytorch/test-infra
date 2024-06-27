set -euxo pipefail

install_hooks() {
  pushd /home/$USER_NAME

  CLEANUP_SCRIPT=/home/$USER_NAME/runner-scripts/cleanup.sh
  # https://github.com/pytorch/test-infra/issues/5246, install pre and post-job hooks
  # to chown everything under actions-runner to $USER_NAME so that the runner can clean
  # up these files
  mkdir -p runner-scripts
  cat > $CLEANUP_SCRIPT <<EOF
#!/bin/bash
sudo chown -R $USER_NAME:$USER_NAME /home/$USER_NAME/actions-runner || true
EOF
  chmod 755 $CLEANUP_SCRIPT

  RUNNER_ENV=/home/$USER_NAME/actions-runner/.env
  # https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/running-scripts-before-or-after-a-job
  STARTED_HOOK="ACTIONS_RUNNER_HOOK_JOB_STARTED=$CLEANUP_SCRIPT"
  COMPLETED_HOOK="ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$CLEANUP_SCRIPT"

  echo $STARTED_HOOK >> $RUNNER_ENV
  echo $COMPLETED_HOOK >> $RUNNER_ENV

  popd
}

cd /home/$USER_NAME
mkdir actions-runner && cd actions-runner

retry aws s3 cp ${s3_location_runner_distribution} actions-runner.tar.gz
tar xzf ./actions-runner.tar.gz
rm -rf actions-runner.tar.gz

install_hooks

${arm_patch}

if [ "$(uname -m)" == "aarch64" ] || uname -a | grep 'amzn2023' > /dev/null; then
  TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  INSTANCE_ID=$(curl http://169.254.169.254/latest/meta-data/instance-id -H "X-aws-ec2-metadata-token: $TOKEN")
  REGION=$(curl -s 169.254.169.254/latest/dynamic/instance-identity/document -H "X-aws-ec2-metadata-token: $TOKEN" | jq -r .region)
else
  INSTANCE_ID=$(wget -q -O - http://169.254.169.254/latest/meta-data/instance-id)
  REGION=$(curl -s 169.254.169.254/latest/dynamic/instance-identity/document | jq -r .region)
fi

echo wait for configuration
while [[ $(aws ssm get-parameters --names ${environment}-$INSTANCE_ID --with-decryption --region $REGION | jq -r ".Parameters | .[0] | .Value") == null ]]; do
    echo Waiting for configuration ...
    sleep 1
done
CONFIG=$(aws ssm get-parameters --names ${environment}-$INSTANCE_ID --with-decryption --region $REGION | jq -r ".Parameters | .[0] | .Value")
retry aws ssm delete-parameter --name ${environment}-$INSTANCE_ID --region $REGION

export RUNNER_ALLOW_RUNASROOT=1
os_id=$(awk -F= '/^ID/{print $2}' /etc/os-release)
if [[ "$os_id" =~ ^ubuntu.* ]]; then
  sudo ./bin/installdependencies.sh
elif uname -a | grep 'amzn2023' > /dev/null; then
  echo "Installing dependencies for Amazon Linux 2023"
  sudo retry dnf install -y lttng-ust openssl-libs krb5-libs zlib libicu
fi

./config.sh --unattended --name $INSTANCE_ID --work "_work" $CONFIG

# Set tag as runner id for scale down later
GH_RUNNER_ID=$(jq '.agentId' .runner)
retry aws ec2 create-tags --region $REGION --resource $INSTANCE_ID --tags "Key=GithubRunnerID,Value=$GH_RUNNER_ID"

chown -R $USER_NAME:$USER_NAME .
OVERWRITE_SERVICE_USER=${run_as_root_user}
SERVICE_USER=$${OVERWRITE_SERVICE_USER:-$USER_NAME}

./svc.sh install $SERVICE_USER

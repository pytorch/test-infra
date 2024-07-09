set -exo pipefail

RUNNER_ENV=/home/$USER_NAME/actions-runner/.env

if [ "$(uname -m)" == "aarch64" ] || uname -a | grep 'amzn2023' > /dev/null; then
  TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  INSTANCE_ID=$(curl http://169.254.169.254/latest/meta-data/instance-id -H "X-aws-ec2-metadata-token: $TOKEN")
  REGION=$(curl -s 169.254.169.254/latest/dynamic/instance-identity/document -H "X-aws-ec2-metadata-token: $TOKEN" | jq -r .region)
else
  INSTANCE_ID=$(wget -q -O - http://169.254.169.254/latest/meta-data/instance-id)
  REGION=$(curl -s 169.254.169.254/latest/dynamic/instance-identity/document | jq -r .region)
fi

install_hooks() {
  pushd /home/$USER_NAME

  BEFORE_JOB_SCRIPT=/home/$USER_NAME/runner-scripts/before_job.sh
  AFTER_JOB_SCRIPT=/home/$USER_NAME/runner-scripts/after_job.sh
  UTILS_SCRIPT=/home/$USER_NAME/runner-scripts/utils.sh

  # https://github.com/pytorch/test-infra/issues/5246, install pre and post-job hooks
  # to chown everything under actions-runner to $USER_NAME so that the runner can clean
  # up these files
  mkdir -p runner-scripts
  cat > $UTILS_SCRIPT <<EOF
#!/bin/bash
function metric_report () {
    local metric_name=$1
    local value=$2
    local on_ami_experiment="standardAMI"

    if [[ -e /home/$USER_NAME/on-ami-experiment ]]; then
      on_ami_experiment="onAMIExperiment"
    fi

    aws cloudwatch put-metric-data --metric-name "$metric_name" --namespace "GHARunners/all" --value $value --region us-east-1 || true

    local namespace="GHARunners/all"
    if [ ! -z "${environment}" ]; then
        namespace="GHARunners/${environment}"
        aws cloudwatch put-metric-data --metric-name "$metric_name" --namespace "$namespace" --value $value --region us-east-1 || true
    fi

    if [ ! -z "$REGION" ]; then
        aws cloudwatch put-metric-data --metric-name "$metric_name" --namespace "$namespace" --value $value --region us-east-1 --dimensions "Region=$REGION" || true
    fi
    if [ ! -z "$OS_ID" ]; then
        aws cloudwatch put-metric-data --metric-name "$metric_name" --namespace "$namespace" --value $value --region us-east-1 --dimensions "os=$OS_ID" || true
    fi
    aws cloudwatch put-metric-data --metric-name "$metric_name" --namespace "$namespace" --value $value --region us-east-1 --dimensions "OnAMIExperiment=$on_ami_experiment" || true
}
EOF
  chmod 755 $UTILS_SCRIPT
  cat > $BEFORE_JOB_SCRIPT <<EOF
#!/bin/bash
. /home/$USER_NAME/runner-scripts/utils.sh

sudo chown -R $USER_NAME:$USER_NAME /home/$USER_NAME/actions-runner
metric_report "runner_scripts.before_job" 1

pushd /home/$USER_NAME/actions-runner/_diag
for filename in Worker_*; do
  mv "$filename" "old_$filename"
done
popd
EOF
  chmod 755 $BEFORE_JOB_SCRIPT
  cat > $AFTER_JOB_SCRIPT <<EOF
#!/bin/bash
. /home/$USER_NAME/runner-scripts/utils.sh

sudo chown -R $USER_NAME:$USER_NAME /home/$USER_NAME/actions-runner
metric_report "runner_scripts.after_job" 1

grep "Job result after all job steps finish: Succeeded" Worker_*  ; FOUND=$?
if [ \$FOUND -eq 0 ]; then
  echo "Job result after all job steps finish: Succeeded"
  metric_report "runner_scripts.job_succeeded" 1
else
  echo "Job result after all job steps finish: Failed/Cancelled"
  metric_report "runner_scripts.job_failed_canceled" 1

  if [ -e /home/$USER_NAME/on-ami-experiment ]; then
    echo "Job failed on AMI experiment, stopping the instance"
    sudo /home/$USER_NAME/actions-runner/svc.sh stop
fi
EOF
  chmod 755 $AFTER_JOB_SCRIPT

  # https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/running-scripts-before-or-after-a-job
  echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$BEFORE_JOB_SCRIPT" >> $RUNNER_ENV
  echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$AFTER_JOB_SCRIPT" >> $RUNNER_ENV

  popd
}

# TODO (huydhn): Remove this after moving to AmazonLinux2023
fallback_to_node16() {
  # https://github.blog/changelog/2024-03-07-github-actions-all-actions-will-run-on-node20-instead-of-node16-by-default/
  FALLBACK_TO_NODE16="ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true"
  export $FALLBACK_TO_NODE16
  echo $FALLBACK_TO_NODE16 >> $RUNNER_ENV
}

cd /home/$USER_NAME
mkdir actions-runner && cd actions-runner

retry aws s3 cp ${s3_location_runner_distribution} actions-runner.tar.gz
tar xzf ./actions-runner.tar.gz
rm -rf actions-runner.tar.gz

install_hooks
fallback_to_node16

${arm_patch}

echo wait for configuration
RETRY_LEFT=600
while [[ $(aws ssm get-parameters --names ${environment}-$INSTANCE_ID --with-decryption --region $REGION | jq -r ".Parameters | .[0] | .Value") == null ]]; do
    echo Waiting for configuration ...
    sleep 1
    RETRY_LEFT=$((RETRY_LEFT-1))
    if [[ $RETRY_LEFT -eq 0 ]]; then
        echo "Timeout waiting for configuration"
        false  # the script should fail when a command returns non-zero, and then send logs about it
    fi
done
CONFIG=$(aws ssm get-parameters --names ${environment}-$INSTANCE_ID --with-decryption --region $REGION | jq -r ".Parameters | .[0] | .Value")
if echo "$CONFIG" | grep -q "#ON_AMI_EXPERIMENT"; then
  CONFIG=$(echo "$CONFIG" | sed 's/ #ON_AMI_EXPERIMENT//g')
  touch /home/$USER_NAME/on-ami-experiment
fi
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

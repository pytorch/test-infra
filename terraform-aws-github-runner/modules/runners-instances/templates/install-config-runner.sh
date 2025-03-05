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
  LOGS_MONITOR=/home/$USER_NAME/runner-scripts/logs_monitor.sh

  MONITOR_SYSTEMD_SERVICE=/etc/systemd/system/gh-daemon-monitor.service
  MONITOR_SYSTEMD_PATH=/etc/systemd/system/gh-daemon-monitor.path

  # https://github.com/pytorch/test-infra/issues/5246, install pre and post-job hooks
  # to chown everything under actions-runner to $USER_NAME so that the runner can clean
  # up these files
  mkdir -p runner-scripts
  cat > $UTILS_SCRIPT <<EOF
#!/bin/bash
function metric_report () {
    local metric_name=\$1
    local value=\$2
    local on_ami_experiment="standardAMI"

    if [[ -e /home/$USER_NAME/on-ami-experiment ]]; then
      on_ami_experiment="onAMIExperiment"
    fi

    aws cloudwatch put-metric-data --metric-name "\$metric_name" --namespace "GHARunners/all/infra" --value \$value --region us-east-1 || true

    local namespace="GHARunners/all/infra"
    if [ ! -z "${environment}" ]; then
        namespace="GHARunners/${environment}/infra"
        aws cloudwatch put-metric-data --metric-name "\$metric_name" --namespace "\$namespace" --value \$value --region us-east-1 || true
    fi

    if [ ! -z "$REGION" ]; then
        aws cloudwatch put-metric-data --metric-name "\$metric_name" --namespace "\$namespace" --value \$value --region us-east-1 --dimensions "Region=$REGION" || true
    fi
    if [ ! -z "$OS_ID" ]; then
        aws cloudwatch put-metric-data --metric-name "\$metric_name" --namespace "\$namespace" --value \$value --region us-east-1 --dimensions "os=$OS_ID" || true
    fi
    while read line ; do
        aws cloudwatch put-metric-data --metric-name "\$metric_name" --namespace "\$namespace" --value \$value --region us-east-1 --dimensions "label=\$line,OnAMIExperiment=\$on_ami_experiment" || true
        aws cloudwatch put-metric-data --metric-name "\$metric_name" --namespace "\$namespace" --value \$value --region us-east-1 --dimensions "label=\$line" || true
    done < /home/$USER_NAME/runner-labels

    aws cloudwatch put-metric-data --metric-name "\$metric_name" --namespace "\$namespace" --value \$value --region us-east-1 --dimensions "OnAMIExperiment=\$on_ami_experiment" || true
}
EOF
  chmod 755 $UTILS_SCRIPT
  cat > $BEFORE_JOB_SCRIPT <<EOF
#!/bin/bash
. /home/$USER_NAME/runner-scripts/utils.sh

sudo chown -R $USER_NAME:$USER_NAME /home/$USER_NAME/actions-runner

# Use the IDMS v2 token
token=\$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 600" -s)

# Use the token to fetch instance metadata
instance_id=\$(curl -H "X-aws-ec2-metadata-token: \$token" -s http://169.254.169.254/latest/meta-data/instance-id)
region=\$(curl -H "X-aws-ec2-metadata-token: \$token" -s http://169.254.169.254/latest/meta-data/placement/region)
runner_type=\$(aws ec2 describe-tags --filters "Name=resource-id,Values=\$instance_id" "Name=key,Values=RunnerType" --query 'Tags[0].Value' --output text --region \$region)
instance_type=\$(curl -H "X-aws-ec2-metadata-token: \$token" -s http://169.254.169.254/latest/meta-data/instance-type)
ami_id=\$(curl -H "X-aws-ec2-metadata-token: \$token" -s http://169.254.169.254/latest/meta-data/ami-id)

echo "Runner Type: \$runner_type"
echo "Instance Type: \$instance_type"

case \$ami_id in
  ami-0ce0c36d7a00b20e2) echo "AMI Name: amzn2-ami-hvm-2.0.20240306.2-x86_64-ebs";;
  ami-06c68f701d8090592) echo "AMI Name: al2023-ami-2023.5.20240701.0-kernel-6.1-x86_64";;
  *) echo "AMI Name: unknown";;
esac

grep 'pswpin' /proc/vmstat | awk '{print $2}' >/tmp/pswpin_before_job || true
grep 'pswpout' /proc/vmstat | awk '{print $2}' >/tmp/pswpout_before_job || true

echo "AMI ID: \$ami_id"

metric_report "runner_scripts.before_job" 1
EOF
  chmod 755 $BEFORE_JOB_SCRIPT
  cat > $AFTER_JOB_SCRIPT <<EOF
#!/bin/bash
. /home/$USER_NAME/runner-scripts/utils.sh

grep 'pswpin' /proc/vmstat | awk '{print $2}' >/tmp/pswpin_after_job || true
grep 'pswpout' /proc/vmstat | awk '{print $2}' >/tmp/pswpout_after_job || true

if cmp --silent /tmp/pswpin_before_job /tmp/pswpin_after_job ; then
  echo "[!ALERT!] Swap in detected! [!ALERT!]"
  metric_report "runner_scripts.swap_in" 1
  metric_report "runner_scripts.swap_op" 1
fi

if cmp --silent /tmp/pswpout_before_job /tmp/pswpout_after_job ; then
  echo "[!ALERT!] Swap out detected [!ALERT!]"
  metric_report "runner_scripts.swap_out" 1
  metric_report "runner_scripts.swap_op" 1
fi

sudo chown -R $USER_NAME:$USER_NAME /home/$USER_NAME/actions-runner
metric_report "runner_scripts.after_job" 1
EOF
  chmod 755 $AFTER_JOB_SCRIPT
  cat > $LOGS_MONITOR <<EOF
#!/bin/bash

. /home/$USER_NAME/runner-scripts/utils.sh

CURR_LOGS_FILE="/home/$USER_NAME/.curr_logs"
PROC_LOGS_FILE="/home/$USER_NAME/.proc_logs"

function update_curr_logs_file {
    pushd /home/$USER_NAME/actions-runner/_diag >/dev/null
    ls -a Worker_* | cat | sort > \$CURR_LOGS_FILE
    popd >/dev/null
}

function get_unprocced_files {
    diff --new-line-format="" --unchanged-line-format="" <(sort \$CURR_LOGS_FILE) <(sort \$PROC_LOGS_FILE)
}

exec > >(tee -a /var/log/gh-daemon-monitor.log | logger -t gh-daemon-monitor -s 2>/dev/console) 2>&1

update_curr_logs_file

while read file; do
    echo "Checking \$file..."
    FULL_PATH_FILE="/home/$USER_NAME/actions-runner/_diag/\$file"

    LINE=\$(grep 'Job result after all job steps finish:' \$FULL_PATH_FILE)

    if [[ ! -z "\$LINE" ]]; then
        echo "File \$file have a job output: '\$LINE'"
        STATUS=\$(echo "\$LINE" | cut -d ':' -f 4 | xargs)

        if [ "\$STATUS" == "Succeeded" ]; then
            echo "Job \$file succeeded"
            metric_report "runner_scripts.job_succeeded" 1
        elif [ "\$STATUS" == "Failed" ]; then
            echo "Job \$file failed"
            metric_report "runner_scripts.job_failed" 1
            if [ -e /home/$USER_NAME/on-ami-experiment ]; then
                echo "Job failed on AMI experiment, stopping the instance"
                pushd /home/$USER_NAME/actions-runner ; ./svc.sh stop ; popd
            fi
        elif [ "\$STATUS" == "Cancelled" ]; then
            echo "Job \$file cancelled"
            metric_report "runner_scripts.job_cancelled" 1
        elif [ "\$STATUS" == "Skipped" ]; then
            echo "Job \$file skipped"
            metric_report "runner_scripts.job_skipped" 1
        else
            echo "Job \$file unknown status: \$STATUS"
            metric_report "runner_scripts.job_unknown" 1
        fi

        echo \$file >> \$PROC_LOGS_FILE
    fi
done < <(get_unprocced_files)
EOF
  chmod 755 $LOGS_MONITOR
  cat > $MONITOR_SYSTEMD_SERVICE <<EOF
[Unit]
Description=monitor updates on logs from github daemon
After=network.target

[Service]
Type=oneshot
ExecStart=$LOGS_MONITOR
EOF
  chmod 644 $MONITOR_SYSTEMD_SERVICE
  cat > $MONITOR_SYSTEMD_PATH <<EOF
[Path]
PathChanged=/home/$USER_NAME/actions-runner/_diag

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 $MONITOR_SYSTEMD_PATH

  systemctl daemon-reload
  systemctl enable gh-daemon-monitor.path
  systemctl start gh-daemon-monitor.path

  # https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/running-scripts-before-or-after-a-job
  echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$BEFORE_JOB_SCRIPT" >> $RUNNER_ENV
  echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$AFTER_JOB_SCRIPT" >> $RUNNER_ENV

  popd
}

get_labels_from_config() {
  while [[ "$#" -gt 0 ]]; do
    case $1 in
      --labels) target="$2"; shift ;;
    esac
    shift
  done
  echo $target | sed 's/,/\n/g'
}

cd /home/$USER_NAME
mkdir actions-runner && cd actions-runner

retry aws s3 cp ${s3_location_runner_distribution} actions-runner.tar.gz
tar xzf ./actions-runner.tar.gz
rm -rf actions-runner.tar.gz

install_hooks

${arm_patch}

echo wait for configuration
RETRY_LEFT=1200  # 20 minutes
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
retry aws ssm delete-parameter --name ${environment}-$INSTANCE_ID --region $REGION

echo "Configuration received: '$CONFIG'"
if echo "$CONFIG" | grep -q "#ON_AMI_EXPERIMENT"; then
  CONFIG=$(echo "$CONFIG" | sed 's/ #ON_AMI_EXPERIMENT//g')
  touch /home/$USER_NAME/on-ami-experiment
fi

get_labels_from_config $CONFIG > /home/$USER_NAME/runner-labels

# We add a tag to the instance to signal that the ephemeral runner has finished
# this is useful to hint the scale up lambda that this instance might be reused
if grep "ephemeral" <<< $CONFIG; then
  echo "Ephemeral runner detected"
  echo "aws ec2 create-tags --region $REGION --resource $INSTANCE_ID --tags \"Key=EphemeralRunnerFinished,Value=\$(date +%s )\""  >> $AFTER_JOB_SCRIPT
fi

export RUNNER_ALLOW_RUNASROOT=1
os_id=$(awk -F= '/^ID/{print $2}' /etc/os-release)
if [[ "$os_id" =~ ^ubuntu.* ]]; then
  sudo ./bin/installdependencies.sh
elif uname -a | grep 'amzn2023' > /dev/null; then
  echo "Installing dependencies for Amazon Linux 2023"
  retry sudo dnf install -y lttng-ust openssl-libs krb5-libs zlib libicu
fi

./config.sh --unattended --name $INSTANCE_ID --work "_work" $CONFIG

# Set tag as runner id for scale down later
GH_RUNNER_ID=$(jq '.agentId' .runner)
retry aws ec2 create-tags --region $REGION --resource $INSTANCE_ID --tags "Key=GithubRunnerID,Value=$GH_RUNNER_ID"

chown -R $USER_NAME:$USER_NAME .
OVERWRITE_SERVICE_USER=${run_as_root_user}
SERVICE_USER=$${OVERWRITE_SERVICE_USER:-$USER_NAME}

./svc.sh install $SERVICE_USER

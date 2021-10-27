cd /home/$USER_NAME
mkdir actions-runner && cd actions-runner

aws s3 cp ${s3_location_runner_distribution} actions-runner.tar.gz
tar xzf ./actions-runner.tar.gz
rm -rf actions-runner.tar.gz

${arm_patch}

INSTANCE_ID=$(wget -q -O - http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s 169.254.169.254/latest/dynamic/instance-identity/document | jq -r .region)

echo wait for configuration
while [[ $(aws ssm get-parameters --names ${environment}-$INSTANCE_ID --with-decryption --region $REGION | jq -r ".Parameters | .[0] | .Value") == null ]]; do
    echo Waiting for configuration ...
    sleep 1
done
CONFIG=$(aws ssm get-parameters --names ${environment}-$INSTANCE_ID --with-decryption --region $REGION | jq -r ".Parameters | .[0] | .Value")
aws ssm delete-parameter --name ${environment}-$INSTANCE_ID --region $REGION

IS_EPHEMERAL=$(aws ssm get-parameters --names ${environment}-$INSTANCE_ID-ephemeral --with-decryption --region $REGION | jq -r ".Parameters | .[0] | .Value")
aws ssm delete-parameter --name ${environment}-$INSTANCE_ID-ephemeral --region $REGION

EPHEMERAL_FLAG="--ephemeral"
if [[ $IS_EPHEMERAL = "0" ]]; then
    EPHEMERAL_FLAG=""
fi

export RUNNER_ALLOW_RUNASROOT=1
os_id=$(awk -F= '/^ID/{print $2}' /etc/os-release)
if [[ "$os_id" =~ ^ubuntu.* ]]; then
    ./bin/installdependencies.sh
fi

(
    set -x
    ./config.sh $EPHEMERAL_FLAG --unattended --name $INSTANCE_ID --work "_work" $CONFIG
)

# Set tag as runner id for scale down later
GH_RUNNER_ID=$(jq '.agentId' .runner)
aws ec2 create-tags --region $REGION --resource $INSTANCE_ID --tags "Key=GithubRunnerID,Value=$GH_RUNNER_ID"

chown -R $USER_NAME:$USER_NAME .
OVERWRITE_SERVICE_USER=${run_as_root_user}
SERVICE_USER=$${OVERWRITE_SERVICE_USER:-$USER_NAME}

./svc.sh install $SERVICE_USER

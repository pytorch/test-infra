#!/usr/bin/env bash
# Mirrors pytorch-gha-infra/macos-runners/scripts/install-ssm-agent.sh.

set -eou pipefail

if grep "amazon-ssm-agent is stopped" /var/log/amazon/ssm/amazon-ssm-agent.log >/dev/null 2>/dev/null; then
  TOKEN=$(curl -s -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 30" http://169.254.169.254/latest/api/token)
  EC2_REGION=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/dynamic/instance-identity/document | jq .region -r)
  ARCH=$(uname -m)
  if [[ "${ARCH}" == "arm64" ]]; then
    SSM_URL="https://s3.${EC2_REGION}.amazonaws.com/amazon-ssm-${EC2_REGION}/latest/darwin_arm64/amazon-ssm-agent.pkg"
  else
    SSM_URL="https://s3.${EC2_REGION}.amazonaws.com/amazon-ssm-${EC2_REGION}/latest/darwin_amd64/amazon-ssm-agent.pkg"
  fi
  curl -fsSL -o /tmp/amazon-ssm-agent.pkg "${SSM_URL}"
  installer -pkg /tmp/amazon-ssm-agent.pkg -target /
  launchctl load -w /Library/LaunchDaemons/com.amazon.aws.ssm.plist && sudo launchctl start com.amazon.aws.ssm
else
  echo -n "SSM INSTALLED"
fi

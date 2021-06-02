<powershell>
$ErrorActionPreference = "Continue"
$VerbosePreference = "Continue"
Start-Transcript -Path "C:\UserData.log" -Append

${pre_install}

# %{~ if enable_cloudwatch_agent ~}
## --- cloudwatch-agent ----
Write-Host "Setting up cloudwatch agent..."
curl -sSLo C:\amazon-cloudwatch-agent.msi https://s3.amazonaws.com/amazoncloudwatch-agent/windows/amd64/latest/amazon-cloudwatch-agent.msi
$cloudwatchParams = '/i', 'C:\amazon-cloudwatch-agent.msi', '/qn', '/L*v', 'C:\CloudwatchInstall.log'
Start-Process "msiexec.exe" $cloudwatchParams -Wait -NoNewWindow
Remove-Item C:\amazon-cloudwatch-agent.msi
& 'C:\Program Files\Amazon\AmazonCloudWatchAgent\amazon-cloudwatch-agent-ctl.ps1' -a fetch-config -m ec2 -s -c ssm:${ssm_key_cloudwatch_agent_config}
# %{~ endif ~}
## --- cloudwatch-agent ----

${install_config_runner}
${post_install}

Stop-Transcript
</powershell>

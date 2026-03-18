Get-MpComputerStatus
Get-Service -Name "WinDefend"

# Other approaches like Stop-Service -Name "WinDefend" or Set-Service -Name "WinDefend" -StartupType Disabled
# lack the permission to remove Windows Defender. Note that uninstalling Windows Defender requires a restart,
# so it would need to be baked into the AMI instead of being part of the CI
Uninstall-WindowsFeature -Name Windows-Defender

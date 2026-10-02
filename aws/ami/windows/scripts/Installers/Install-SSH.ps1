# Taken from: https://docs.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse

# Fail the AMI build instead of publishing an image whose sshd cannot start.
$ErrorActionPreference = 'Stop'

$sshDir = 'C:\ProgramData\ssh'
# Uploaded by windows.pkr.hcl. Kept out of $sshDir so that directory does not
# exist before the first sshd start (see below).
$stagedConfig = 'C:\Windows\Temp\sshd_config'
$sshd = "$env:WINDIR\System32\OpenSSH\sshd.exe"

function Write-SshdDiagnostic {
    # Under 'Stop', Windows PowerShell 5.1 turns the first native stderr line
    # redirected by 2>&1 into a terminating error, cutting the output short.
    $ErrorActionPreference = 'Continue'
    Write-Output '--- sshd -t'
    & $sshd -t 2>&1 | Out-String | Write-Output
    Write-Output '--- OpenSSH/Operational events'
    Get-WinEvent -LogName 'OpenSSH/Operational' -MaxEvents 20 -ErrorAction SilentlyContinue |
        Format-List TimeCreated, Message | Out-String | Write-Output
    Write-Output "--- ACLs under $sshDir"
    icacls $sshDir /T 2>&1 | Out-String | Write-Output
}

function Invoke-SshdStart {
    try {
        Start-Service sshd
    } catch {
        Write-SshdDiagnostic
        throw
    }
    if ((Get-Service sshd).Status -ne 'Running') {
        Write-SshdDiagnostic
        throw 'sshd is not running'
    }
}

Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# Let the first start create $sshDir and the host keys with the ACLs OpenSSH
# sets up itself. Creating the directory beforehand leaves it with the
# inherited C:\ProgramData ACLs, which sshd can reject at startup.
Invoke-SshdStart
Stop-Service sshd

Copy-Item -Path $stagedConfig -Destination "$sshDir\sshd_config" -Force
# Only SYSTEM and Administrators may write sshd_config (well-known SIDs, so this
# does not depend on the OS display language).
icacls "$sshDir\sshd_config" /inheritance:r /grant '*S-1-5-18:F' /grant '*S-1-5-32-544:F'
if ($LASTEXITCODE -ne 0) {
    throw "icacls failed with exit code $LASTEXITCODE"
}

Set-Service -Name sshd -StartupType 'Automatic'
Invoke-SshdStart

# Confirm the firewall rule is configured. It should be created automatically by setup.
Get-NetFirewallRule -Name *ssh*

# There should be a firewall rule named "OpenSSH-Server-In-TCP", which should be enabled
# If the firewall does not exist, create one
if (-not (Get-NetFirewallRule -Name sshd -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule `
      -Name sshd `
      -DisplayName 'OpenSSH Server (sshd)' `
      -Enabled True `
      -Direction Inbound `
      -Protocol TCP `
      -Action Allow `
      -LocalPort 22
}

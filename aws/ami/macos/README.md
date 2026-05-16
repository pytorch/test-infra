# Build macOS AMIs

This folder uses Packer to bake reusable macOS AMIs for PyTorch GHA CI
runners, mirroring the layout under `../windows`.

The baked AMI contains everything host-shape-independent — Homebrew
packages (`gh`, `jq`, `tmux`, `libomp`, `pstree`, `miniconda` cask),
`conda init`, the `runner` user, the SSM agent, the CloudWatch agent
binary + plist, `/opt/runner_scripts/`, and `boto3`/`botocore` for the
runtime Ansible plays. Per-instance steps (IAM role attach, GH runner
registration, starting the CloudWatch daemon with the live config)
remain in the runtime playbooks under
`pytorch-gha-infra/macos-runners/playbooks`.

## Why per-arch AMIs are enough

AWS publishes one `arm64_mac` base AMI per macOS version, and one
`x86_64_mac` base AMI per macOS version. There is no per-chip variant
(no separate M1/M2/M2-Pro/M4 AMI). A custom AMI built from one of those
base images is portable across every Apple Silicon Mac instance family
(`mac2.metal`, `mac2-m2.metal`, `mac2-m2pro.metal`, `mac2-m4*.metal`).
Build matrix is therefore `(arch, macos_version)` — 2-4 AMIs total in
practice, not 10+.

## Why a Python driver instead of plain `packer build`

EC2 Mac instances require a Dedicated Host. Dedicated Mac hosts have:

- A **24-hour minimum billing window**. Releasing earlier still costs a
  full day.
- A **~1-2 hour scrubbing window** after every instance terminates,
  during which the host cannot accept a new launch.

Letting Packer allocate and release a host per build would cost one
host-day per AMI. The driver script (`build_macos_ami.py`) allocates a
single host, runs N packer builds sequentially against it (waiting out
the scrub window between builds), and leaves it allocated by default so
you don't pay for a fresh day on the next invocation.

## Setup

1. Configure AWS credentials (`AWS_PROFILE=fbossci` for the PyTorch CI
   account).
2. Install Packer
   ([instructions](https://developer.hashicorp.com/packer/tutorials/docker-get-started/get-started-install-cli)).
3. Install Ansible locally (Packer's Ansible provisioner runs it from
   the build host, not the target):
   ```bash
   pip install ansible boto3
   ansible-galaxy install -r ansible/requirements.yml
   ```
4. `cd` here and run `packer init .` (the driver also does this).

## Usage

### Host discovery

If `--host-id` is not passed, the driver looks for an existing Dedicated
Host tagged `Name=packer-macos-arm64-builder` in `--region`. The first
idle match (state `available`, no running instances) is reused;
otherwise the driver allocates a fresh host with that same tag. Pass
`--no-reuse` to force allocation, or `--host-id h-...` to pin to a
specific host.

This means the common case is one command, no manual host bookkeeping:

```bash
AWS_PROFILE=fbossci python build_macos_ami.py --region us-east-2 --macos-version 14
```

### Build all supported macOS versions on one host (cost-optimal)

```bash
AWS_PROFILE=fbossci python build_macos_ami.py \
    --region us-east-2 \
    --macos-version 14 \
    --macos-version 15 \
    --macos-version 26
```

Mac dedicated hosts have a 24h billing minimum, so amortizing multiple
builds across one host avoids paying for multiple host-days.

### Smoke-test the provisioners without creating an AMI

```bash
AWS_PROFILE=fbossci python build_macos_ami.py \
    --region us-east-2 --macos-version 14 --skip-create-ami
```

### Release the host when fully done

```bash
aws ec2 release-hosts --host-ids h-0123456789abcdef0 --region us-east-1
```

Or pass `--release-after` to the driver (note: still billed for 24h).

## Multi-region publication

The template defaults to publishing the AMI to both `us-east-1` and
`us-east-2` (the regions PyTorch CI currently runs Mac runners in).
Packer registers in the build region first, then issues `CopyImage` to
the other regions in the list — each copy creates a fresh AMI ID and a
fresh EBS snapshot in that region.

To narrow or widen the set, pass `ami_regions` through:

```bash
python build_macos_ami.py \
  --host-id h-... --region us-east-2 --macos-version 14 \
  --packer-extra-arg='-var=ami_regions=["us-east-1","us-east-2","us-west-2"]'
```

CopyImage is roughly free at the API level but each destination region
incurs snapshot storage (~$0.05/GB-month) and a one-time inter-region
data-transfer charge for the snapshot.

## Consuming the AMI from Terraform

Mirror the Windows pattern in
`pytorch-gha-infra/runners/regions/us-east-1/main.tf`:

```hcl
ami_owners_macos_arm64 = ["<this-account-id>"]
ami_filter_macos_arm64 = {
  name         = ["pytorch-ci-macos-14-arm64-*"]
  architecture = ["arm64_mac"]
}
```

Because the same AMI name lands in every region in `ami_regions` (with
different IDs), Terraform's per-region lookup naturally resolves to the
local copy without extra configuration. The AMI name embeds
`(macos_version, arch, timestamp)`, so filters can be as broad or
narrow as needed.

## Layout

```
macos/
├── README.md                       # this file
├── plugins.pkr.hcl                 # required packer plugins (amazon, ansible)
├── variables.pkr.hcl               # input variables
├── macos.pkr.hcl                   # source + build blocks
├── build_macos_ami.py              # host-lifecycle driver
├── ansible/
│   ├── bake.yml                    # tasks baked into the AMI
│   └── requirements.yml            # ansible-galaxy deps
├── scripts/                        # shipped to /opt/runner_scripts/ in AMI
│   ├── create-runner-user.sh
│   └── install-ssm-agent.sh
└── configs/
    └── cloudwatch_config.json      # staged for the runtime playbook
```

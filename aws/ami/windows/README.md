# Build Windows AMIs
This folder uses Packer to build Windows AMIs and upload them to AWS

# Setup
1. Setup your AWS credentials. Either set the env vars `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` with the keys needed to connect to the AWS account you want the AMI created in, or use one of the other authentication methods described [here](https://developer.hashicorp.com/packer/integrations/hashicorp/amazon#authentication).
1. Install packer ([steps](https://developer.hashicorp.com/packer/tutorials/docker-get-started/get-started-install-cli))
1. Install VSCode plugin [HashiCorp HCL](https://marketplace.visualstudio.com/items?itemName=HashiCorp.HCL) for syntax highlighting of packer files
1. From this folder, run `packer init .`

# Building the Windows AMIs
Windows AMIs can be built using packer.

When run, packer will:
1. Create an EC2 instance on AWS with the desired base OS image
2. Run the reqeuested provisioning steps on it
3. If `skip_create_ami` is false, then it will create a new AMI from the resulting VM state and save it to the AWS account

All the following commands should be run from this directory.

## Testing
Run the provisioning steps without saving the new AMI (for testing the build process):
```
packer build .
```

## Build and upload to AWS
Same as above, but actually generate the windows AMI from the resulting EC2 instance.

This AMI will be referencable by when spinning up new EC2 machines.
```
packer build -var 'skip_create_ami=false' .
```

The resulting AMIs can be found under `us-east-1`  and `us-east-2` with the name prefix of **Windows 2019 GHA CI - {{timestamp}}**.

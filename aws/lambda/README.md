# AWS Lambda Functions
This folder contains lambda functions used by the AWS Lambda service and managed by the PyTorch team.

## Adding a New Lambda Function
### Step 1: Code Structure and Deployment File
Create a new folder under this folder with the name of the lambda function, It should contain:
* `lambda_function.py`: the lambda function code.
* `requirements.txt`: the dependencies of the lambda function.
* `.gitignore`: the gitignore file.
* `Makefile`: the makefile is used to build the lambda function package.
* `[Recommended]README.MD`: a README file that explains what the lambda function does and how to use it.
* `[Recommended]tests`: you can put your tests in `aws/lambda/tests` folder. The tests will be run by the CI.

Refer to exmaple: [aws/lambda/oss_ci_job_queue_time](https://github.com/pytorch/test-infra/tree/99c977d429aa2eb27bc77e1783b0578e8a83e550/aws/lambda/oss_ci_job_queue_time).

#### Makefile Example

```makefile
all: run-local

clean:
    rm -rf deployment
    rm -rf venv
    rm -rf deployment.zip

venv/bin/python:
    virtualenv venv
    venv/bin/pip install -r requirements.txt

deployment.zip:
    mkdir -p deployment
    cp lambda_function.py ./deployment/.
    pip3.10 install -r requirements.txt -t ./deployment/. --platform manylinux2014_x86_64 --only-binary=:all: --implementation cp --python-version 3.10 --upgrade
    cd ./deployment && zip -q -r ../deployment.zip .

.PHONY: create-deployment-package
create-deployment-package: deployment.zip
```

### Step 2: Add Deployment Step in Runner Release Workflow
Add a deployment step to `.github/workflows/_lambda-do-release-runners.yml`.  If you followed the directions above and have a simple python lambda, add your folder and zip name to [the list of python lambdas](https://github.com/pytorch/test-infra/blob/f2c6cbeba65e94e877379cfe88d723e81749ead7/.github/workflows/_lambda-do-release-runners.yml#L88).  If are not working in python or need more complex logic, use the examples in that file to write a custom job, and remember to add it to [the list of jobs needed to run for the full release](https://github.com/pytorch/test-infra/blob/f2c6cbeba65e94e877379cfe88d723e81749ead7/.github/workflows/_lambda-do-release-runners.yml#L128).

### Step 3: Trigger a Release

Once the release step is added, submit the code. Then go to workflow action [Create Release Tag](https://github.com/pytorch/test-infra/actions/workflows/lambda-release-tag-runners.yml) and trigger a release by creating a new tag.

#### Finding Release Artifacts

From the steps such as "Run ncipollo/release-action@v1", you can see the release tag and the release name.

```bash
Run ncipollo/release-action@v1
  with:
    artifacts: ci-queue-pct.zip
    allowUpdates: true
    draft: true
    name: v20250422-162548
    tag: v20250422-162548
```

Use the release name to find your release artifacts in the release page. [pytorch/test-infra/releases](https://github.com/pytorch/test-infra/releases). If you build successfully, you can find your zip file in the release Assets.

## Setup infra resources and deploy the function to cloud
Go to [pytorch-gha-infra](https://github.com/meta-pytorch/pytorch-gha-infra)

### Setup Permission and Deployment for the lambda function
   - Add your lambda function config (such as create role, func-name, and permissions), similar to [PR: set up Aws Resources for queue time histogram lambda ](https://github.com/meta-pytorch/pytorch-gha-infra/pull/647)
        -  You should only grab permission the lambda need for resource access, make sure to ask one person from pytorch dev infra team to review the permission.
   - Update the release-tag and add your zip file name in [runners/common/Terrafile](https://github.com/meta-pytorch/pytorch-gha-infra/blob/5fde9cdadaad584de3140488adba8eb9c9fe6722/runners/common/Terrafile)
        -  During the deploy process, the workflow will download your file based on the Terrafile.
   - If you need ClickHouse account permission, you need ask pytorch dev infra teammate to create a ClickHouse role for your lambda.
       - Add the ClickHouse role secret to the repo secret,  `bunnylol oss meta-pytorch/pytorch-gha-infra` and update it in settings-> secrets.

### Deploy the lambda
Once the pr is submitted, go to [Runners Do Terraform Release (apply)](https://github.com/meta-pytorch/pytorch-gha-infra/actions/workflows/runners-on-dispatch-release.yml), and click Run workflow.


Page maintainers: @pytorch/pytorch-dev-infra
<br>
Last verified: 2025-06-27

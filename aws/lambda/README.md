# AWS Lambda functions
This folder contains lambda_functions that are used by the AWS Lambda service and manged by Pytorch team.


# How to add a new lambda function
1. Create a new folder under this folder with the name of the lambda function. It should contains:
    - lambda_function.py: the lambda function code.
    - requirements.txt: the dependencies of the lambda function.
    - .gitignore: the gitignore file.
    - Makefile: the makefile is used to build the lambda function package.
    - [Recommended]README.MD: a README file that explains what the lambda function does and how to use it.
    - [Recommended]tests: you can put your tests in aws/lambda/tests folder. The tests will be run by the CI.

Makefile example:
```
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

2. Add deployment step to .github/workflows/lambda-do-release-runners.yml
similar to [pr:[Queue Time Histogram] Add deployment step](https://github.com/pytorch/test-infra/pull/6505)
Add a release step to [lambda-do-release-runners.ym](https://github.com/pytorch/test-infra/blob/bde647d78a327030c9b5a87d21fdd28ad5431a63/.github/workflows/lambda-do-release-runners.yml)

```yml
 release-${YOUR_LAMBDA_FUNCTION_NAME}:
    name:  Upload Release for ${YOUR_LAMBDA_FUNCTION_NAME} lambda
    runs-on: ubuntu-latest
    permissions:
      contents: write
    env:
      REF: ${{ inputs.tag }}
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          ref: ${{ inputs.tag }}

      - uses: actions/setup-python@v5
        with:
          python-version: '3.10'

      - name: Build deployment.zip
        working-directory: aws/lambda/${YOUR_LAMBDA_FUNCTION_FOLDER_NAME}
        run: make deployment.zip

      - name: Copy deployment.zip to root
        run: cp aws/lambda/${YOUR_LAMBDA_FUNCTION_FOLDER_NAME}/deployment.zip ${YOUR_LAMBDA_FUNCTION_ZIP_NAME}.zip

      - uses: ncipollo/release-action@v1
        with:
          artifacts: "${YOUR_LAMBDA_FUNCTION_ZIP_NAME}.zip"
          allowUpdates: true
          draft: true
          name: ${{ inputs.tag }}
          tag: ${{ inputs.tag }}
          updateOnlyUnreleased: true
```
Once the release step is added, submit the code.
Then go to workflow action [Create Release Tag](https://github.com/pytorch/test-infra/actions/workflows/lambda-release-tag-runners.yml), it uses lambda-release-tag-runners
and trigger a release by creating a new tag.
From the steps such as Run ncipollo/release-action@v1, you can see the release tag and the release name.

```bash
Run ncipollo/release-action@v1
  with:
    artifacts: ci-queue-pct.zip
    allowUpdates: true
    draft: true
    name: v20250422-162548
    tag: v20250422-162548
```
Use the release name, you can find your release artifacts in the release page. [pytorch/test-infra/releases][https://github.com/pytorch/test-infra/releases],
If you build successfully, you can find your zip file in the release Assets.

3. Setup Permission and Deployment for the lambda function
   - go to [pytorch-gha-infra](https://github.com/pytorch-labs/pytorch-gha-infra)
   - Add your lambda function config, similar to [pr:set up Aws Resources for queue time histogram lambda ](https://github.com/pytorch-labs/pytorch-gha-infra/pull/647)
   - You need to add the asset name and update the release tag  in [runners/common/Terrafile](https://github.com/pytorch-labs/pytorch-gha-infra/blob/main/runners/common/Terrafile)
   - If you need clichouse account permission, you need ask pytorch dev infra teammate to create a clichouse role for your lambda.

4. Deploy the lambda
Once the pr is submitted, go to [Runners Do Terraform Release (apply)](https://github.com/pytorch-labs/pytorch-gha-infra/actions/workflows/runners-on-dispatch-release.yml), and click Run workflow.

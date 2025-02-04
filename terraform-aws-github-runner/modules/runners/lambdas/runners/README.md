# Runners Autoscaler Lambda Infrastucture - Typescript code

This folder contains the typescript code for the scaleUp and scaleDown lambdas

## Local Development

### Requirements

Node, pip, yarn, cmake

### Development main workflow

Most of the development is done using `yarn`, in order to setup the project, run:

```
$ yarn install
```

Next, you can run unit test by:

```
$ yarn test
```

after completing your changes, please run:

```
$ yarn commit-check
```

This should lint the code, format it, make sure it is building properly and run tests. If your command succeeds, it will be green on CI.

### Expectations

It is **required** to submit code:

* All unit tests are passing;
* At least 80% unit test coverage;
* No linting warnings are being thrown;
* The code must be fully compilable to javascript;
* Code formatting are according to current standards (prettier);

It is *advisable* to strive to when submitting code:

* Improve as much as possible unit test code coverage;

### Yarn commands

| Command        | What do they do?                              |
| -------------- | ------------------                            |
| test           | Run unit tests                                |
| lint           | Run linting                                   |
| build          | compiles typescript to javascript             |
| dist           | build + create lambda zip `runners.zip`       |
| format         | run prettier so code follows layout standard  |
| commit-check   | format + lint + test + build                  |

### Makefile helpers

Those are primarly used for CI, but, it might be useful to understand, there are 3 commands:

| Command      | Yarn Equivalents                             |
| ------------ | ------------------                           |
| clean        | - just clean temp/build files                |
| build        | install + lint + format-check + build + test |
| dist         | install + dist                               |

### Troubleshoot/debug

Most of the code, to run properly, expects to connect to external services and have a series of environment setup. It is not really possible to simply run the code localy without mocking aggressively. If you can't easily troubleshoot or implement your changes relying on unit test (rare cases) it is possible to run your code in AWS EC2.

**WARNING: In practice, even with canary, we only have production environment, be aware that you can break things when running tests!**

So, it is not really recommended to do so, unless troubleshooting something that you have limited understanding and can't replicate locally.

#### Requirements needed:

* Admin access to the exact environment where lambdas run;
* Access to all relevant secrets for production;
* Create an EC2 instance (more details below);

#### Setup the test environment

Names of roles and details of the secrets are dependent if you are testing scaleDown or scaleUp lambdas. Please update commands below accordingly.

* Add the `AmazonSSMManagedEC2IntanceDefaultPolicy` and `AmazonSSMManagedInstanceCore` policy to `gh-ci-action-scale-down-lambda-role`:

```
local$ aws attach-role-policy --role-name gh-ci-action-scale-down-lambda-role --policy-arn arn:aws:iam::aws:policy/service-role/AmazonSSMManagedEC2IntanceDefaultPolicy
local$ aws attach-role-policy --role-name gh-ci-action-scale-down-lambda-role --policy-arn arn:aws:iam::aws:policy/service-role/AmazonSSMManagedInstanceCore
```

* Create an instance profile for this role (if it does not exists already):

```
local$ aws iam create-instance-profile --instance-profile-name gh-ci-action-scale-down-lambda-profile
```

* Assign the lambda role to the instance profile:

```
local$ aws iam add-role-to-instance-profile --role-name gh-ci-action-scale-down-lambda-role --instance-profile-name gh-ci-action-scale-down-lambda-profile
```

* Go to web console (easier IMO) and update the trust relationships for the given role so EC2 can assume it:

```
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": [
                    "lambda.amazonaws.com",
                    "ec2.amazonaws.com"
                ]
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
```

* Create a AWS instance, please attach more disk space so you can troubleshoot and run things worry free.
  * Important to select the **SAME** vpc that your lambda is using: `$ aws lambda get-function-configuration --function-name gh-ci-scale-down --query 'VpcConfig.VpcId' --output text`;
  * Important to select the role/role-profile you created during creation;
  * Use AMZN Linux 2023, latest version;
  * Select your ssh keys;

* You should't be able to SSH to it directly, so it is recommended to use SSM to connect. In order of making things easier use the `aws-ssh-session` hacky script available on `terraform-aws-github-runner/tools/aws-ssh-session` of this repository. This script should create a ssh port-forwarding so you can both ssh to it AND scp:

```
local$ aws-ssh-session <instance-id> ec2-user us-east-1
```

* Install node:

```
remote$ sudo yum install nodejs
```

* scp your already built `index.js`:

```
local$ scp -C -P 5113 dist/index.js ec2-user@127.0.0.1:/home/ec2-user/.
```

* You can use the script `run-aws-lambda-helper` (terraform-aws-github-runner/tools/run-aws-lambda-helper) from your laptop to create a script export all relevant environment variables and call your lambda:

```
local$ run-aws-lambda-helper gh-ci-scale-down us-east-1 >run-lambda.sh
local$ scp -C -P 5113 run-lambda.sh ec2-user@127.0.0.1:/home/ec2-user/.
remote$ bash run-lambda.sh
```

* If you prefer to do things manually:
  * Just export all environment variables as the lambda function, adding `FUNCTION_NAME`, `AWS_REGION` and `AWS_DEFAULT_REGION`;
  * Run your lambda with: `node -e 'require("./index").scaleDown({}, {}, {});'`

**IMPORTANT WARNINGS**

* Those environment variables are SECRETS, be very careful not to expose them;
* The environment variables **MUST BE UP TO DATE**, some variables changes during each deployment, and mistmatching them can potentially cause runner disruptions!

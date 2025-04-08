# Partners PyTorch CI Runners

This document tries to facilitate and guide partners who want to contribute with PyTorch CI providing runners. This guide is mostly intended for a static fleet of runners. In case the goal is either to use ARC or the `terraform-aws-github-runner` module provided in this repository this does not apply.

## Overall view of the process

### Reasoning

In the past we ended up collecting a large number of stale, offline runners. So now we enforce that any offline CI runner is automatically deleted from the list of available CI runners for PyTorch. This should not introduce any work for dynamically scaled instances, quite the opposite, as it allows the developer to not worry about cleanup and stale instances. But it can be a bit extra work for providers of a static fleet of instances.

Another advantage of having this is the fact that it enables PyTorch Foundation to quickly isolate and remove runners that are problematic or suffered a security incident, even if they are dynamically scaled (so deleting one-by-one is not an option).

### Overview

To register runners, the partner should create a github app visible to PyTorch org in GH, requesting the relevant read and write access to organization self hosted runners. Note that this is the exact same steps required to setup ARC or `terraform-aws-github-runner`. But for this case there is no need to subscribe to any events.

As a next step, the partner should reach out to one of the PyTorch org admins and request the installation of the app, making sure its scope is limited to `pytorch/pytorch` repository. It is advisable to open an issue in pytorch/test-infra to help coordinate the operation and facilitate the communication between multiple stakeholders.

> [!NOTE]
> Github apps are simply a method of authentication, similar to tokens

Once the app is installed (in other words, permissions are granted) the app administrator should generate and download a private key. Please note that tokens are not sufficient for the use case.

> [!WARNING]
> This key is **VERY** sensitive it is important to avoid leaking it, and generate a new one as soon as necessary if any incident occurs.
> Do not store it in the runners themselves, as usually they can run commands as `root` or `admin` and even if they can't there is a risk of privilege escalation.
> With those keys, a badly intentioned attacker can register any runner, with any label, and poison the PyTorch binaries that are distributed, without leaving any trace that can be detected.

So, the final step is to generate a token to register a runner. This can be accomplished by [performing an API request directly via CuRL](https://docs.github.com/en/rest/actions/self-hosted-runners?apiVersion=2022-11-28#create-a-registration-token-for-a-repository) or using a script. Note that this step will require your private key, the app id, and the app installation id.

## Code examples for key generation

### Using PyGithub

```
auth = Auth.AppAuth(get_github_app_id(), get_private_key()).get_installation_auth(get_github_app_installation_id())
gh_app =  Github(auth=auth)
pytorch_repo = gh_client.get_repo('pytorch/pytorch)
_, data = pytorch_repo._requester.requestJsonAndCheck(
    "POST",
    f"/repos/pytorch/pytorch/actions/runners/registration-token",
)
print(data['token'])
```

# self-hosted-runner-utils

This is a collection of utilities to help facilitate our self hosted infrastructure for Github Actions,
these are meant to be general purpose and can be re-used for other projects wishing to have some level
of self hosted infra utilities.

## Dependency installation

Dependencies for these utils are found in the requirements.txt, you can install using:

```
pip install -r requirements.txt
```

## Formatting

Tools here are formatted with black, use the `Makefile` to format your code:

```
make format
```

## clear_offline_runners.py

This is a utility to clear offline self hosted runners. The reason why this may be necessary is if your
scale down lambda does not always clear up self hosted runners on the Github side, so this is useful for
doing all of that in one swoop

> NOTE: You do need adminstrator access to use this script

> NOTE: GITHUB_TOKEN should be set in your environment for this script to work properly

### Usage

```bash
# python clear_offline_runners.py <REPO>
python clear_offline_runners.py pytorch/pytorch
```

There are also dry run options to just show which runners would be deleted


```bash
python clear_offline_runners.py pytorch/pytorch --dry-run
```

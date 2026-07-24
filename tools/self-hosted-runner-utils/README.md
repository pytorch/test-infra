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

## check_runners_state.py

A utility to check overall stats for self hosted runners.

> NOTE: You do need adminstrator access to use this script

> NOTE: GITHUB_TOKEN should be set in your environment for this script to work properly

### Usage

```bash
# python check_runners_state.py <REPO>
python check_runners_state.py pytorch/pytorch
```

## cloudwatch_logs.py

This utility downloads logs from AWS CloudWatch for a specific function or log group. It can retrieve logs from a specified time range and save them to a file.

> NOTE: You need to have your AWS credentials configured for this script to work properly.

### Usage

By default, the script downloads logs from the last day.

```bash
# Download logs for a Lambda function
python cloudwatch_logs.py my-lambda-function
```

You can specify a time range using human-readable formats.

```bash
# Download logs from the last 2 hours for a function
python cloudwatch_logs.py my-lambda-function --start-time "2 hours ago" --end-time "now"

# Download logs for a specific ISO timestamp range
python cloudwatch_logs.py my-lambda-function --start-time "2024-07-01T10:00:00" --end-time "2024-07-01T12:00:00"
```

By default, logs are printed to stdout. You can pipe the output to other commands or redirect it to a file:

```bash
# Pipe logs to grep
python cloudwatch_logs.py my-lambda-function | grep "ERROR"

# Redirect output to a file
python cloudwatch_logs.py my-lambda-function > my-logs.txt
```

You can also specify an output file directly using the `--output-file` option:

```bash
# Download logs from a custom log group and save to a file
python cloudwatch_logs.py my-service --log-group "/aws/ecs/my-service" --output-file my-service.log
```

A dry run option is available to see what would be downloaded without fetching the logs.

```bash
python cloudwatch_logs.py my-lambda-function --dry-run
```

You can also stream logs in real-time using the `--tail` option:

```bash
# Stream logs in real-time
python cloudwatch_logs.py my-lambda-function --tail

# Stream logs with a custom polling interval (in seconds)
python cloudwatch_logs.py my-lambda-function --tail --poll-interval 10
```

The `--tail` option will continuously poll for new logs and display them as they arrive. Press Ctrl+C to stop streaming.

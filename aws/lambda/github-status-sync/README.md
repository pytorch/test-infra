This lambda updates data in S3 that is used by hud.pytorch.org on the main status page. It lists out the top N commits for a branch along with the statuses for each.

## Configuration

Mandatory:

- `app_id` - the GitHub App ID to authenticate with (e.g. `1234351`)
- `private_key` - a private key generated from the GitHub App with newlines replaced with `|` characters
- `bucket` - s3 bucket to write to (e.g. `ossci-job-status`), the Lambda should be configured to have write access to the S3 `bucket`

Optional:

- `branches` - comma separated list of branches to handle: `master,main,nightly,viable/strict,release/1.10`
- `repo` - GitHub repository (e.g. `vision`)
- `user` - GitHub username (e.g. `pytorch`)
- `history_size` - number of commits to fetch in the past (e.g. `100`)

### `update_triggers.py`

These can optionally be configured via an EventBridge event (which would let you sync multiple repos at different rates from a single lambda). Use `update_triggers.py` to configure how you want the Lambda to run and execute it with the relevant AWS credentials.

```bash
pip install -r cli-requirements.txt
export ACCOUNT_ID=1234
python update_triggers.py
```

### Manual events

You can also add events via the AWS console:

1. In the Lambda triggers configuration page, add a new EventBridge trigger to run on a schedule (e.g. `rate(1 minute)`).
2. Click on the EventBridge event and got "Edit" it
3. In "Select targets" expand "Configure input" and choose "Constant (JSON text)". Paste in something like this

   ```json
   {
     "branches": "master,main,nightly,viable/strict,release/1.10",
     "user": "pytorch",
     "repo": "pytorch",
     "history_size": 100
   }
   ```

4. "Update" to save the changes, monitor the logs to ensure the Lambda is functioning correctly

## Local Development

Use the environment variables above along with `DEBUG=1` to run locally.

```bash
# One-time setup
export DEBUG=1
export app_id=1234
export bucket=ossci-job-status
export private_key=$(cat key.pem | tr '\n' '|')

# Run and debug
python lambda_function.py
```

**Note**: The `cryptography` package relies on binaries, so you can only deploy this from a Linux machine (doing it from MacOS will result in errors reading ELF headers at import time)

## Manual invocation

You can also use `update_triggers.py` to manually call the lambda for one of the rules defined in `update_triggers.py`.

```bash
# e.g. sync the pytorch/pytorch/master branch
python update_triggers.py invoke --rule sync-pytorch-pytorch
```

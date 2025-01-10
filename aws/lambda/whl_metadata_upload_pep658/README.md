This lambda is used on the pytorch AWS account to upload metadata files from whl
to be used in [pep658].  They are then added to the index by
[s3_management/manage.py][managepy].

This account does not use terraform, so this is the source of truth for the
code, and the configuration should be:
* time limit: at least 30s?
* ephemeral memory: at least size of the largest whl we want to upload metadata for
* Triggers:
  * s3: put object events from pytorch bucket with suffix `.whl`

### Deployment

A new version of the lambda can be deployed using `make deploy`.  It is also
done automatically in CI in
`.github/workflows/deploy_lambda_whl_metadata_upload_pep658.yml`.

### Testing + Backfill

Please see `test_lambda_function.py`.

[pep658]: https://peps.python.org/pep-0658/
[managepy]: https://github.com/pytorch/test-infra/blob/73eea9088162354f937230cb518f19f50f557062/s3_management/manage.py

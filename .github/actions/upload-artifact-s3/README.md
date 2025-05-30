# `pytorch/test-infra/.github/actions/upload-artifact-s3`

Upload [Actions Artifacts](https://docs.github.com/en/actions/using-workflows/storing-workflow-data-as-artifacts) from your Workflow Runs to an AWS S3 bucket.
Based on [@actions/upload-artifact](https://github.com/actions/upload-artifact).

See also [download-artifact-s3](https://github.com/pytorch/test-infra/main/tree/.github/actions/download-artifact-s3).

- [`pytorch/test-infra/.github/actions/upload-artifact-s3`](#pytorchtest-infragithubactionsupload-artifact-s3)
  - [v6 - What's new](#v6---whats-new)
  - [Usage](#usage)
    - [Inputs](#inputs)
    - [Outputs](#outputs)
  - [Examples](#examples)
    - [Upload an Individual File](#upload-an-individual-file)
    - [Upload an Entire Directory](#upload-an-entire-directory)
    - [Upload using a Wildcard Pattern](#upload-using-a-wildcard-pattern)
    - [Upload using Multiple Paths and Exclusions](#upload-using-multiple-paths-and-exclusions)
    - [Customization if no files are found](#customization-if-no-files-are-found)
    - [Environment Variables and Tilde Expansion](#environment-variables-and-tilde-expansion)
    - [Retention Period](#retention-period)
    - [Using Outputs](#using-outputs)
      - [Example output between steps](#example-output-between-steps)
      - [Example output between jobs](#example-output-between-jobs)
    - [Overwriting an Artifact](#overwriting-an-artifact)
    - [Uploading Hidden Files](#uploading-hidden-files)


## v6 - What's new

The release of upload-artifact-s3 v6 based on the revamped version v4 of @actions/upload-artifact and the AWS SDK v3.
It is now possible to set the ACL for the uploaded artifact directly in the workflow.

## Usage

### Inputs

```yaml
- uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
  with:
    # Name of the artifact to upload.
    # Optional. Default is 'artifact'
    # See s3-prefix below.
    name:

    # A file, directory or wildcard pattern that describes what to upload
    # Required.
    path:

    # The desired behavior if no files are found using the provided path.
    # Available Options:
    #   warn: Output a warning but do not fail the action
    #   error: Fail the action with an error message
    #   ignore: Do not output any warnings or errors, the action does not fail
    # Optional. Default is 'warn'
    if-no-files-found:

    # Duration after which artifact will expire in days. 0 means using default retention.
    # Minimum 1 day.
    # Maximum 90 days unless changed from the repository settings page.
    # Optional. Defaults to repository settings.
    retention-days:

    # Access control list for the S3 objects.
    # Can be any of the canned ACLs supported by S3;
    # To make it generally available, set to 'public-read'
    # Optional. Defaults to 'private'.
    s3-acl:

    # The S3 bucket to use for the artifacts.
    # Typically something like 'gha-artifacts'.
    # Defaults to 'gha-artifacts'.
    s3-bucket:

    # Prefix to use for the upload keys.
    # The object key will be composed of this prefix and the path of the file to be uploaded relative to the root directory.
    # If this is set, the name parameter above is ignored;
    # if it is not set, it defaults to '${repo_owner}/${repo_name}/${run_id}/${artifact_name}'
    s3-prefix:

    # The region that contains the bucket.
    # Defaults to 'us-east-1'.
    region:

    # If true, an artifact with a matching name will be deleted before a new one is uploaded.
    # If false, the action will fail if an artifact for the given name already exists.
    # Does not fail if the artifact does not exist.
    # Optional. Default is 'false'
    overwrite:

    # Whether to include hidden files in the provided path in the artifact
    # The file contents of any hidden files in the path should be validated before
    # enabled this to avoid uploading sensitive information.
    # Optional. Default is 'false'
    include-hidden-files:
```

### Outputs

The only output is `uploaded-objects`.
It is a json encoded dictionary mapping keys of successful uploads to additional metadata, namely the objects eTag and canonical url, that is the url of the form `https://<bucket>.s3.<region>.amazonaws.com/<key>` that allows access given correct permissions.

Example (formatted for easier readability):
```
{
  "source_code/test/test-artifact.txt": {
    "etag": "\"723ae057c7abd1bae38ffd7ad5710a78\"",
    "canonicalUrl": "https://myuniversaltestbucket.s3.eu-north-1.amazonaws.com/source_code/test/test-artifact.txt"
  }
}
```

## Examples

### Upload an Individual File

```yaml
steps:
- run: mkdir -p path/to/artifact
- run: echo hello > path/to/artifact/world.txt
- uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
  with:
    region: eu-north-1
    s3-bucket: myuniversaltestbucket
    name: my-artifact
    path: path/to/artifact/world.txt
```

### Upload an Entire Directory

```yaml
- uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
  with:
    region: eu-north-1
    s3-bucket: myuniversaltestbucket
    name: my-artifact
    path: path/to/artifact/ # or path/to/artifact
```

### Upload using a Wildcard Pattern

```yaml
- uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
  with:
    region: eu-north-1
    s3-bucket: myuniversaltestbucket
    name: my-artifact
    path: path/**/[abc]rtifac?/*
```

### Upload using Multiple Paths and Exclusions

```yaml
- uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
  with:
    region: eu-north-1
    s3-bucket: myuniversaltestbucket
    name: my-artifact
    path: |
      path/output/bin/
      path/output/test-results
      !path/**/*.tmp
```

For supported wildcards along with behavior and documentation, see [@actions/glob](https://github.com/actions/toolkit/tree/main/packages/glob) which is used internally to search for files.

If a wildcard pattern is used, the path hierarchy will be preserved after the first wildcard pattern:

```
path/to/*/directory/foo?.txt =>
    ∟ path/to/some/directory/foo1.txt
    ∟ path/to/some/directory/foo2.txt
    ∟ path/to/other/directory/foo1.txt

would be flattened and uploaded as =>
    ∟ some/directory/foo1.txt
    ∟ some/directory/foo2.txt
    ∟ other/directory/foo1.txt
```

If multiple paths are provided as input, the least common ancestor of all the search paths will be used as the root directory of the artifact. Exclude paths do not affect the directory structure.

Relative and absolute file paths are both allowed. Relative paths are rooted against the current working directory. Paths that begin with a wildcard character should be quoted to avoid being interpreted as YAML aliases.

### Customization if no files are found

If a path (or paths), result in no files being found for the artifact, the action will succeed but print out a warning. In certain scenarios it may be desirable to fail the action or suppress the warning. The `if-no-files-found` option allows you to customize the behavior of the action if no files are found:

```yaml
- uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
  with:
    name: my-artifact
    path: path/to/artifact/
    if-no-files-found: error # 'warn' or 'ignore' are also available, defaults to `warn`
```

### Environment Variables and Tilde Expansion

You can use `~` in the path input as a substitute for `$HOME`. Basic tilde expansion is supported:

```yaml
  - run: |
      mkdir -p ~/new/artifact
      echo hello > ~/new/artifact/world.txt
  - uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
    with:
      name: my-artifacts
      path: ~/new/**/*
```

Environment variables along with context expressions can also be used for input. For documentation see [context and expression syntax](https://help.github.com/en/actions/reference/context-and-expression-syntax-for-github-actions):

```yaml
    env:
      name: my-artifact
    steps:
    - run: |
        mkdir -p ${{ github.workspace }}/artifact
        echo hello > ${{ github.workspace }}/artifact/world.txt
    - uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
      with:
        name: ${{ env.name }}-name
        path: ${{ github.workspace }}/artifact/**/*
```

For environment variables created in other steps, make sure to use the `env` expression syntax

```yaml
    steps:
    - run: |
        mkdir testing
        echo "This is a file to upload" > testing/file.txt
        echo "artifactPath=testing/file.txt" >> $GITHUB_ENV
    - uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
      with:
        name: artifact
        path: ${{ env.artifactPath }} # this will resolve to testing/file.txt at runtime
```

### Retention Period

Artifacts are retained for 90 days by default. You can specify a shorter retention period using the `retention-days` input:

```yaml
  - name: Create a file
    run: echo "I won't live long" > my_file.txt

  - name: Upload Artifact
    uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
    with:
      name: my-artifact
      path: my_file.txt
      retention-days: 5
```

The retention period must be between 1 and 90 inclusive. For more information see [artifact and log retention policies](https://docs.github.com/en/free-pro-team@latest/actions/reference/usage-limits-billing-and-administration#artifact-and-log-retention-policy).

### Using Outputs

If an artifact upload is successful then an `uploaded-objects` output is available.

#### Example output between steps

```yml
    - uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
      id: artifact-upload-step
      with:
        name: my-artifact
        path: path/to/artifact/content/

    - name: Output artifact ID
      run:  echo 'Artifact ID is ${{ steps.artifact-upload-step.outputs.uploaded-objects }}'
```

#### Example output between jobs

```yml
jobs:
  job1:
    runs-on: ubuntu-latest
    outputs:
      output1: ${{ steps.artifact-upload-step.outputs.artifact-id }}
    steps:
      - uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
        id: artifact-upload-step
        with:
          name: my-artifact
          path: path/to/artifact/content/
  job2:
    runs-on: ubuntu-latest
    needs: job1
    steps:
      - env:
          OUTPUT1: ${{needs.job1.outputs.output1}}
        run: echo "Artifact ID from previous job is $OUTPUT1"
```

### Overwriting an Artifact

Although it's not possible to mutate an Artifact, one can completely overwrite one.

```yaml
jobs:
  upload:
    runs-on: ubuntu-latest
    steps:
      - name: Create a file
        run: echo "hello world" > my-file.txt
      - name: Upload Artifact
        uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
        with:
          name: my-artifact # NOTE: same artifact name
          path: my-file.txt
  upload-again:
    needs: upload
    runs-on: ubuntu-latest
    steps:
      - name: Create a different file
        run: echo "goodbye world" > my-file.txt
      - name: Upload Artifact
        uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
        with:
          name: my-artifact # NOTE: same artifact name
          path: my-file.txt
          overwrite: true
```

### Uploading Hidden Files

By default, hidden files are ignored by this action to avoid unintentionally uploading sensitive information.

If you need to upload hidden files, you can use the `include-hidden-files` input.
Any files that contain sensitive information that should not be in the uploaded artifact can be excluded
using the `path`:

```yaml
- uses: pytorch/test-infra/.github/actions/upload-artifact-s3@v6
  with:
    name: my-artifact
    include-hidden-files: true
    path: |
      path/output/
      !path/output/.production.env
```

Hidden files are defined as any file beginning with `.` or files within folders beginning with `.`.
On Windows, files and directories with the hidden attribute are not considered hidden files unless
they have the `.` prefix.

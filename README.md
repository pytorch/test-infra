# Lintrunner
## Overview
`lintrunner` is a tool that runs linters. It is responsible for:
- Deciding which files need to be linted.
- Invoking linters according to a common protocol.
- Gathering results and presenting them to users.

The intention is to provide a universal way to configure and invoke linters, which is useful on large polyglot projects.

The design of `lintrunner` is heavily inspired by `linttool`, a project that exists internally at Meta.

## Installation
Currently, do:
```
cargo install lintrunner --force
```

In the future we’ll probably do binary releases through GitHub, `pip`, or `conda`.
## Usage
First, you need to add a configuration file to your repo. See the [Linter configuration](#linter-configuration) section for more info.

Then, simply run `lintrunner` to lint your changes!

## How `lintrunner` decides what files to lint
When run with no arguments, it will check:
- The files changed in the `HEAD` commit.
- The files changed in the user’s working tree.

It does *not* check:
- Any files not tracked by `git`; `git add` them to lint them.

To lint a specific file or files, pass them as positional arguments:
```
lintrunner foo.py bar.cpp
```

For more control, you can specify  `--paths-cmd`. If `--paths-cmd` is specified, `lintrunner` will execute that command and consider each line of its `stdout` to be a file to lint. For example, the canonical way to check every path in the repo is:
```
lintrunner --paths-cmd='git grep -Il .'
```

## Linter configuration
`lintrunner` knows which linters to run and how by looking at a configuration file, conventionally named `.lintrunner.toml`.

Here is an example linter configuration:

```toml
[[linter]]
name = 'FLAKE8'
include_patterns = [
  'src/**/*.py',  # unix-style globs supported
  'test/**/*.py',
]
exclude_patterns = ['src/my_bad_file.py']
command = [
  'python3',
  'flake8_linter.py',
  '—-',
  # {{PATHSFILE}} gets rewritten to a tmpfile containing all paths to lint
  '@{{PATHSFILE}}',
]
```

A complete description of the configuration schema can be found [here](https://docs.rs/lintrunner/latest/lintrunner/lint_config/struct.LintConfig.html).

## Linter protocol
Most linters have their own output format and arguments. In order to impose consistency on linter invocation and outputs, `lintrunner` implements a protocol that it expects linters to fulfill. In most cases, a small script (called a *linter adapter*) is required to implement the protocol for a given external linter. You can see some example adapters in  `examples/` .

### Invocation
Linters will be invoked according to the `command` specified by their configuration. They will be called once per lint run.

If a linter needs to know which paths to run on, it should take a `{{PATHSFILE}}` argument. During invocation, the string `{{PATHSFILE}}` will be replaced with the name of a temporary file containing which paths the linter should run on, one path per line.

A common way to implement this in a linter adapter is to use `argparse`’s [`fromfile_prefix_chars`](https://docs.python.org/3/library/argparse.html#fromfile-prefix-chars) feature. In the Flake8 example above, we use `@` as the `fromfile_prefix_chars` argument, so `argparse` will automatically read the `{{PATHSFILE}}` and supply its contents as a list of arguments.

### Output
Any lint messages a linter would like to communicate the user must be represented as a `LintMessage`. The linter, must print `LintMessage`s  as [JSON Lines] (https://jsonlines.org/) to `stdout`, one message per line. Output to `stderr` will be ignored.

A complete description of the LintMessage schema can be found [here](https://docs.rs/lintrunner/latest/lintrunner/lint_message/struct.LintMessage.html).

### Exiting
Linters **should always exit with code 0**. This is true even if lint errors are reported; `lintrunner` itself will determine how to exit based on what linters report.

To signal a general linter failure (which should ideally never happen!), linters can return a `LintMessage` with `path = None`.

In the event a linter exits non-zero, it will be caught by `lintrunner`and presented as a “general linter failure” with stdout/stderr shown to the user. This should be considered a bug in the linter’s implementation of this protocol.

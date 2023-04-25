Scripts
=======
This directory contains scripts that can be used to run various
analysis tools on the codebase in a quick local mode or a slightly
more expensive mode that runs in the environment CI does.

To run in CI mode, add the `--create-environment` flag to any of the
scripts. With this flag, each tool will first create a new virtual
environment and install the same packages into it, including the Bosco
source, that CI does.
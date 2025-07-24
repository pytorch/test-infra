# BC Linter for vLLM
PR: https://github.com/vllm-project/vllm/pull/21234

## Code Path
Cover the following code path:
- vllm/v1/attetion/**
- vllm/v1/core/**

Additionally, we should have flexibility to cover other code path in the future.

## Lint Rules
- Check backward compatibility for dataclasses/functions defined python files in code path above
- The default behavior for linter is to check all the dataclasses/public functions in the code path, but we provide an option to skip bc-linter for some experimental dataclasses/functions with `@bc_linter_skip` decorator

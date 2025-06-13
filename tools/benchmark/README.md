# Benchmark Tool

This project includes scripts to provide benchmark tools for users and devs.

# Generate.sh
The generate.sh used to generate dataModels from json files for both TS and Python environment
- TypeScript interface from a JSON Schema
- Pydantic (Python) model from the same schema
- zod schema (for runtime validation in TypeScript) from the generated interface

## how to use it
### Use it from source
When files changes in `test-infra/tools/benchmark/data_models` changes, go to dir `test-infra/tools/benchmark/`, and run
```
run ./generate.sh
```

### Run scripts
To run the python script, go to `test-infra/tools/`, and call script:
```
PYTHONPATH=benchmark python3 benchmark/pytorch_benchmark_lib/cli/benchmark_execu_analysis.py \
  --startTime "2025-06-01T00:00:00" \
  --endTime "2025-06-06T00:00:00" \
  --env local
```

### Use it as a python library
To use it as a python library with pip install:

```
cd test-infra/tools/benchmark
pip install -e . && pip install -r requirements.txt
```

to run the script:
```
fetch-execu-benchmark --startTime "2025-06-01T00:00:00" --endTime "2025-06-06T00:00:00" --env local
```

to import data_model (python3)
```python3
from pytorch_benchmark_lib.data_models.benchmark_query_group_data_model import (
   BenchmarkQueryGroupDataParams,
)

BenchmarkQueryGroupDataParams
```

to import lib (python3)
```python3
from pytorch_benchmark_lib.lib.benchmark_execu_query_api import (
    fetch_execu_benchmark_data,
)
```

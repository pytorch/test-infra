# Benchmark Tool
This project includes scripts to provide benchmark tools for users and devs.

# Structure

The structure of the benchmark tool is as follows:
```
tools/
└── benchmarks/
    ├── pytorch_benchmark_lib/ # main entry point for benchmark library
    │   ├── __init__.py
    │   ├── lib/               # lib methods can be imported and used
    │   │   ├── __init__.py
    │   │   └── benchmark_execu_query_api.py
    │   └── data_models/      # data models can be imported and used
    │   │    ├── __init__.py
    │   │    └── benchmark_query_group_data_model.py
    │   └── cli/                  # cli can be used in command line to run scripts
    ├── README.md
    └── requirements.txt
    └── generate.sh  # generate python and ts data models from json files
    └── zod-generate.sh # generate zod schema from ts interface
```

# Generate.sh
The generate.sh used to generate dataModels from json files for both TS and Python environment
- TypeScript interface from a JSON Schema
- Pydantic (Python) model from the same schema
- zod schema (for runtime validation in TypeScript) from the generated interface

## update data models
When files changes in `test-infra/tools/benchmark/data_models` changes, go to dir `test-infra/tools/benchmark/`, and run
```

```


## Benchmark Tool Usage
### Use it from source

### Run scripts
To run the python script,benchmark_execu_analysis as example:
, go to `test-infra/tools/`, and run:
```
PYTHONPATH=benchmark python3 benchmark/pytorch_benchmark_lib/cli/benchmark_execu_analysis.py \
  --startTime "2025-06-01T00:00:00" \
  --endTime "2025-06-06T00:00:00" \
  --env local
```

### Use it as pip package
#### Use it as a cli
To use the cli, benchmark_execu_analysis as example, with pip install:
```
cd test-infra/tools/benchmark
pip install -e . && pip install -r requirements.txt
```

to run the script, for instance, benchmark_execu_analysis is registered as fetch-execu-benchmark:
```
fetch-execu-benchmark --startTime "2025-06-01T00:00:00" --endTime "2025-06-06T00:00:00" --env local
```

#### Use it as a python library
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

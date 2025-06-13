# Benchmark Tool
This project includes scripts to provide benchmark tools for users and devs.

# Structure

The structure of the benchmark tool is as follows:
```
tools/
└── benchmarks/
    ├── pt2_bm_tools/ # main entry point for benchmark library
    │   ├── __init__.py
    │   ├── lib/               # lib methods can be imported and used
    │   │   ├── __init__.py
    │   │   └── benchmark_execu_query_api.py
    │   └── data_models/      # data models can be imported and used
    │       ├── __init__.py
    │       └── benchmark_query_group_data_model.py
    └── cli/                  # cement-baed cli can be used in command line to run scripts
    ├── README.md
    └── requirements.txt
    └── generate.sh  # generate python and ts data models from json files
    └── zod-generate.sh # generate zod schema from ts interface
```

# Update data models
The generate.sh used to generate dataModels from json schema files located in test-infra/tools/benchmark/data_models/. It generate data model for both TS and Python environment.
- TypeScript interface from a JSON Schema
- Pydantic (Python) model from the same schema [Validation included]
- zod schema (for runtime validation in TypeScript) from the generated interface [Validation included]

To update the data models, when files changes in `test-infra/tools/benchmark/data_models` changes, run:
```
cd test-infra/tools/benchmark
./generate.sh
```

## Benchmark Tool Usage
### cli tool: pt2-bm-cli
the cli tool is based on cement.

To use the cli tool from source, run:
```
cd test-infra/tools/benchmark
pip install -e .
```
to check the cli help:
```
 pt2-bm-cli --help
```

to fetch execubench data from startTime to endTime:
```
pt2-bm-cli group-data-query --name execubench --startTime "2025-06-01T00:00:00" --endTime "2025-06-06T00:00:00" run
```
### import python lib in python
to import data_model (python3)
```python3
from pt2_bm_tools.data_models.benchmark_query_group_data_model import (
   BenchmarkQueryGroupDataParams,
)

BenchmarkQueryGroupDataParams
```

to import lib (python3)
```python3
from pt2_bm_tools.lib.fetch_group_data import (
    fetch_group_data,
    ferch_group_data_execubench
)
```

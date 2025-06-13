# Benchmark Tool
================
Provide a set of tools for users and developers for pytorch benchmark data and api.

## Quick Install
---------------

To install the Benchmark Tool, run the following commands:

```bash
cd test-infra/tools/benchmark
pip install .
```

## Benchmark Tooling
-------------------

### CLI Tool: pt2-bm-cli

The `pt2-bm-cli` tool is based on [Cement](https://github.com/datafolklabs/cement).

#### Checking CLI Help

To check the available options and commands, run:

```bash
pt2-bm-cli --help
```

#### Fetching ExecuBench Data

To fetch ExecuBench data from a specific start time to end time, run:

```bash
pt2-bm-cli group-data-query --name execubench --startTime "2025-06-01T00:00:00" --endTime "2025-06-06T00:00:00" run
```

### Importing Python Library

To import the `data_model` module in Python, use:

```python
from pt2_bm_tools.data_models.benchmark_query_group_data_model import (
    BenchmarkQueryGroupDataParams,
)
```

To import the `lib` module in Python, use:

```python
from pt2_bm_tools.lib.fetch_group_data import (
    fetch_group_data,
    fetch_group_data_execubench,
)
```

## Structure
------------

The Benchmark Tool has the following structure:

```markdown
tools/
└── benchmarks/
    ├── pt2_bm_tools/ # main entry point for benchmark library
    │   ├── __init__.py
    │   ├── lib/               # lib methods can be imported and used in python env
    │   │   ├── __init__.py
    │   │   └── benchmark_execu_query_api.py
    │   └── data_models/      # data models can be imported and used
    │       ├── __init__.py
    │       └── benchmark_query_group_data_model.py
    └── cli/                  # cement-based cli tool
    ├── README.md
    └── requirements.txt      # dev dependencies for benchmark tool
    └── generate.sh           # bash script to generate python and ts data models from json files
    └── zod-generate.sh       # bash script to generate zod schema from ts interface
```

## Data Models
----------------------

the data models are generated from the json schema files in `test-infra/tools/benchmark/data_models`. The data models are used to represent the benchmark data and api.

### Generating Data Models

To generate data models, run:

```bash
cd test-infra/tools/benchmark
./generate.sh
```

This will update the related data models based on the JSON schema configuration. The generated data models include:

* TypeScript interfaces from JSON Schemas
* Pydantic (Python) models from the same schema with validation included
* Zod schema (for runtime validation in TypeScript) from the generated interface with validation included

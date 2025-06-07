#!/bin/bash
set -e  # exit immediately if any command fails

# 1. Generate TypeScript interface from JSON Schema
npx json-schema-to-typescript \
  --input benchmark_query_group_data.schema.json \
  --output ../../torchci/lib/benchmark/dataModels/benchmark_query_group_data_model.ts

# 2. Generate Python Pydantic model from the same JSON Schema
# Ensure the output directory exists
mkdir -p data-models

# Uncomment if not installed yet
# pip3 install datamodel-code-generator
# pip3 install pydantic

datamodel-codegen \
  --input benchmark_query_group_data.schema.json \
  --input-file-type jsonschema \
  --output data-models/benchmark_query_group_data_model.py


SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TORCHCI_DIR="$SCRIPT_DIR/../../torchci"
GEN_ZOD_SCRIPT="$SCRIPT_DIR/zod-generate.sh"

cd "$TORCHCI_DIR" && "$GEN_ZOD_SCRIPT" ./lib/benchmark/dataModels/benchmark_query_group_data_model.ts ./lib/benchmark/dataModels/benchmark_query_group_data_model.zod.ts

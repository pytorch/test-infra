#!/bin/bash
set -e  # exit immediately if any command fails

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TORCHCI_DIR="$SCRIPT_DIR/../../torchci"
GEN_ZOD_SCRIPT="$SCRIPT_DIR/zod-generate.sh"
SCHEMA_DIR="$SCRIPT_DIR/data_schemas"
PYTHON_DATA_MODEL_DST="$SCRIPT_DIR/pt2_bm_tools/data_models"
TS_DATA_MODEL_DST="$TORCHCI_DIR/lib/benchmark/dataModels"

# Generate TypeScript interface from JSON Schema
npx json-schema-to-typescript \
  --input "$SCHEMA_DIR/benchmark_query_group_data.schema.json" \
  --output "$TS_DATA_MODEL_DST/benchmark_query_group_data_model.ts"

# Generate python datamodel from JSON Schema
datamodel-codegen \
  --input  "$SCHEMA_DIR/benchmark_query_group_data.schema.json" \
  --input-file-type jsonschema \
  --output "$PYTHON_DATA_MODEL_DST/benchmark_query_group_data_model.py"

cd "$TORCHCI_DIR" && "$GEN_ZOD_SCRIPT" ./lib/benchmark/dataModels/benchmark_query_group_data_model.ts ./lib/benchmark/dataModels/benchmark_query_group_data_model.zod.ts

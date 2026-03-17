#!/bin/bash
# Build step: create an artifact and output to OUTPUT_PATH

echo "=== Build Step ==="
echo "Creating build artifact..."

# OUTPUT_PATH is automatically set by runner
echo "OUTPUT_PATH: $OUTPUT_PATH"

echo "custom env var: $BUILD_ENV"

# Create artifact file
echo "Build completed at $(date)" > "$OUTPUT_PATH/build_result.txt"
echo "Build version: 1.0.0" >> "$OUTPUT_PATH/build_result.txt"
echo "Build host: $(hostname)" >> "$OUTPUT_PATH/build_result.txt"

CPU_COUNT=$(nproc)
echo "CPU count: $CPU_COUNT"

# Show what we created
echo "Created artifact:"
cat "$OUTPUT_PATH/build_result.txt"

adadafsa

echo "=== Build Step Done ==="

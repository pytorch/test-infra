#!/bin/bash
set -e

echo "Script is running from: $(pwd)"

# Usage help
if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <input_path.ts> <output_path.ts>"
  exit 1
fi

INPUT_PATH="$1"
OUTPUT_PATH="$2"
CONFIG_FILE=".ts-to-zodrc.json"

# Create config file
cat > "$CONFIG_FILE" <<EOF
{
  "input": "$INPUT_PATH",
  "output": "$OUTPUT_PATH"
}
EOF

echo "[DEBUG] Contents of $CONFIG_FILE:"
cat "$CONFIG_FILE"

# Run ts-to-zod
npx ts-to-zod  "$INPUT_PATH" "$OUTPUT_PATH"

# Clean up
rm "$CONFIG_FILE"

echo "Zod schema generated at: $OUTPUT_PATH"

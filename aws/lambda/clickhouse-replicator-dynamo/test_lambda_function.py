import json
from pathlib import Path
from lambda_function import handle_event

if __name__ == "__main__":
    with open(Path(__file__).parent / "sample.json") as f:
        event = json.load(f)
    handle_event(event, dry_run=True)

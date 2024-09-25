import json
from pathlib import Path
from lambda_function import handle_event

if __name__ == "__main__":
    # Uses the sample.json file to test the lambda function.  Does not perform
    # the insert.  Does not go through error path.  Prints the query so you can
    # try it out in the console.  Change the database to fortesting to check.
    with open(Path(__file__).parent / "sample.json") as f:
        event = json.load(f)
    handle_event(event, dry_run=False)

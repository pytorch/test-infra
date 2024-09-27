import json
from pathlib import Path
from lambda_function import handle_event
from contextlib import redirect_stdout
import io

if __name__ == "__main__":
    # Uses the sample.json file to test the lambda function.  Does not perform
    # the insert.  Does not go through error path.  Prints the query so you can
    # try it out in the console.  Change the database to fortesting to check.
    with open(Path(__file__).parent / "sample_workflow_job.json") as f:
        event = json.load(f)

    f = io.StringIO()
    with redirect_stdout(f):
        handle_event(event, dry_run=True)

    s = f.getvalue()
    query = [line for line in s.split("\n") if line.startswith("INSERT INTO")][0]

    with open(Path(__file__).parent / "generated_query.sql", "w") as f:
        print(query, file=f)

    with open(Path(__file__).parent / "expected_query.sql") as f:
        expected_query = f.read().strip()

    if query != expected_query:
        raise ValueError(
            "Queries do not match.  Compare expected_query.sql to generated_query.sql"
        )

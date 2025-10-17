import json

from torchci.clickhouse import query_clickhouse

ALL_TESTS_QUERY = """
SELECT
    name,
    classname,
    invoking_file
FROM (
    SELECT
        name,
        classname,
        invoking_file,
        maxMerge(last_run) AS last_run
    FROM tests.distinct_names
    GROUP BY name, classname, invoking_file
)
WHERE last_run > now() - INTERVAL 1 WEEK
"""


if __name__ == "__main__":
    all_tests = query_clickhouse(
        ALL_TESTS_QUERY, {}
    )
    for test in all_tests:
        test["file"] = test["invoking_file"].replace(".", "/") + ".py"
        del test["invoking_file"]

    with open("td_all_tests.json", mode="w") as file:
        json.dump(all_tests, file, sort_keys=True, indent=2)

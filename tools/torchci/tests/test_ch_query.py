import os
import time
import unittest

from dotenv import load_dotenv
from torchci.clickhouse import (
    get_clickhouse_client,
    query_clickhouse,
    query_clickhouse_saved,
)


# This test is intended to run locally against a real ClickHouse instance
# Provide the necessary environment variables (e.g., in a .env file)
class TestClickhouseQueries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        load_dotenv()
        # Check if ClickHouse credentials are available
        cls.can_run = all(
            env_var in os.environ
            for env_var in [
                "CLICKHOUSE_ENDPOINT",
                "CLICKHOUSE_USERNAME",
                "CLICKHOUSE_PASSWORD",
            ]
        )
        if not cls.can_run:
            print("Skipping ClickHouse tests: required environment variables not set")
        else:
            # Test connection before running tests
            try:
                client = get_clickhouse_client()
                # Simple query to check connection
                client.query("SELECT 1")
                cls.can_run = True
            except Exception as e:
                print(f"ClickHouse connection failed: {e}")
                cls.can_run = False

    def setUp(self):
        """Skip tests if ClickHouse is not available"""
        if not self.can_run:
            self.skipTest(
                "ClickHouse environment variables not set or connection failed"
            )

    def test_simple_query_no_cache(self):
        """Test a simple SELECT 1 query without cache"""
        query = "SELECT 1 AS value"
        results = query_clickhouse(query, {}, use_cache=False)

        self.assertIsInstance(results, list)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["value"], 1)

    def test_simple_query_with_cache(self):
        """Test a simple SELECT 1 query with cache"""
        query = "SELECT 1 AS value"

        # First call should hit database
        start_time = time.time()
        results1 = query_clickhouse(query, {}, use_cache=True)
        first_call_time = time.time() - start_time

        # Second call should use cache
        start_time = time.time()
        results2 = query_clickhouse(query, {}, use_cache=True)
        second_call_time = time.time() - start_time

        # Both should return same result
        self.assertEqual(results1, results2)
        self.assertEqual(results1[0]["value"], 1)

        # Second call should be faster or similar (allowing for measurement noise)
        # We don't assert on exact timing as it depends on many factors
        print(
            f"First call: {first_call_time:.6f}s, Second call: {second_call_time:.6f}s"
        )

    def test_simple_query_with_clickhouse_cache(self):
        """Test a simple query with ClickHouse's query cache"""
        query = "SELECT 1 AS value"

        # First call
        results1 = query_clickhouse(query, {}, use_ch_query_cache=True)

        # Second call
        results2 = query_clickhouse(query, {}, use_ch_query_cache=True)

        # Both should return same result
        self.assertEqual(results1, results2)
        self.assertEqual(results1[0]["value"], 1)

    def test_parameterized_query(self):
        """Test a query with parameters"""
        query = "SELECT {value:UInt8} AS value"
        params = {"value": 42}

        results = query_clickhouse(query, params)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["value"], 42)

    def test_saved_query(self):
        """Test using a saved query (issue_query)"""
        try:
            results = query_clickhouse_saved("issue_query", {"label": "flaky"})
            self.assertIsInstance(results, list)

            # Check structure of results based on query.sql
            if results:
                expected_columns = [
                    "number",
                    "title",
                    "html_url",
                    "state",
                    "body",
                    "updated_at",
                    "author_association",
                    "labels",
                ]
                for col in expected_columns:
                    self.assertIn(col, results[0], f"Missing expected column: {col}")
        except Exception as e:
            self.fail(f"Saved query test failed with: {e}")

    def test_saved_query_with_cache(self):
        """Test saved query with cache"""
        params = {"label": "bug"}

        # First call with timing
        start_time = time.time()
        results1 = query_clickhouse_saved("issue_query", params, useChQueryCache=True)
        first_call_time = time.time() - start_time

        # Second call with timing
        start_time = time.time()
        results2 = query_clickhouse_saved("issue_query", params, useChQueryCache=True)
        second_call_time = time.time() - start_time

        # Print timing information
        print(
            f"Saved query - First call: {first_call_time:.6f}s, Second call: {second_call_time:.6f}s"
        )
        print(
            f"Speedup ratio: {first_call_time/second_call_time if second_call_time > 0 else 'inf':.2f}x"
        )

        # Both should return same data structure
        self.assertEqual(type(results1), type(results2))

        # Verify the results are identical (same number of rows)
        self.assertEqual(
            len(results1),
            len(results2),
            "Cached query returned different number of results",
        )

        # If we got results, check they match expected structure based on query.sql
        if results1:
            expected_columns = [
                "number",
                "title",
                "html_url",
                "state",
                "body",
                "updated_at",
                "author_association",
                "labels",
            ]
            for col in expected_columns:
                self.assertIn(col, results1[0], f"Missing expected column: {col}")

            # Verify the labels array contains the search parameter
            if results1[0]["labels"]:
                # At least one issue should have the label we searched for
                found_label = False
                for issue in results1:
                    if any(label == params["label"] for label in issue["labels"]):
                        found_label = True
                        break
                self.assertTrue(
                    found_label,
                    f"Couldn't find any issue with label '{params['label']}'",
                )
            else:
                # If there are no labels, the test will pass but we'll print a warning
                print(
                    "Warning: No labels found in results, can't verify label filtering"
                )


if __name__ == "__main__":
    unittest.main()

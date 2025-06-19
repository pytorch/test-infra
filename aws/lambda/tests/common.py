from typing import Any, List, Tuple
from unittest.mock import MagicMock


class MockClickHouseQuery:
    """
    Base mock class for ClickHouse queries used in unit tests. used with setup_mock_db_client

    Usage:
    - Subclass this and override `get_response_for_query()` to provide custom responses
      based on SQL query string patterns.
    - Use `setup_mock_db_client()` to inject the mock behavior into a ClickHouse client mock.

    Example:
        #setup customized query return
        class MyQueryMock(MockClickHouseQuery):
            def get_response_for_query(self, query, parameters, type=""):
                if type == "empty":
                    return (), []
                return  ("id", "value"), [(1, "a"), (2, "b")]

        class TestCostExplorerProcessor(unittest.TestCase):

            # assume this is a unit test class that call the get_clickhouse_client function, which returns a clickhouse client
            def setUp(self):
                # Mock get_clickhouse_client method
                get_clickhouse_client_patcher = patch(
                    "module.get_clickhouse_client"
                )
                self.mock_get_cc = get_clickhouse_client_patcher.start()
                self.addCleanup(get_clickhouse_client_patcher.stop)

                # Set up the mock for clickhouse client
                self.mock_cc = MagicMock()
                setup_mock_db_client(self.mock_cc, MyQueryMock(), "", False)
                self.mock_get_cc.return_value = self.mock_cc

            def test_fetch_max_time_missing_rows_throws_error(self):
                # change the behavior of the mock client
                setup_mock_db_client(self.mock_cc, MyQueryMock(), "empty", False)

                processor = CostExplorerProcessor()
                with self.assertRaises(ValueError) as context:
                    processor.start()
                self.assertTrue("Expected 1 row, got 0" in str(context.exception))
    """

    def __init__(
        self,
    ) -> None:
        return

    def mock_query_result(self, query: str, parameters: None, type: str = "") -> Any:
        """Main method to plug into .side_effect for query()."""
        column_names, rows = self.get_response_for_query(query, parameters, type)
        result = MagicMock()
        result.column_names = column_names
        result.result_rows = rows
        result.row_count = len(rows)
        return result

    def get_response_for_query(
        self, query: str, parameters: None, type: str = ""
    ) -> Tuple[Tuple[str, ...], List[Tuple]]:
        """Override this method in a subclass to change query routing logic."""
        return (), []


def setup_mock_db_client(
    mock: Any,
    mock_query: MockClickHouseQuery,
    query_type: str = "",
    is_patch: bool = True,
) -> None:
    """
    Attach a mocked `.query()` method to a ClickHouse client using the provided `mock_query`.
    Parameters:
    - mock (Any): A mock object or a mock patch's return_value, usually a MagicMock.
    - mock_query (MockClickHouseQuery): An instance of a subclass of MockClickHouseQuery.
    - query_type (str): Optional string passed to help with routing in custom mocks.
    - is_patch (bool): Set to True if `mock` is a patch's result (i.e. mock.return_value),
                       False if it's a direct mock client.

    Behavior:
    - Sets `mock.query.side_effect` to call `mock_query.mock_query_result(query, parameters, query_type)`,
      which in turn delegates to `get_response_for_query`.

    Example:

        class CustomQuery(MockClickHouseQuery):
            def get_response_for_query(self, query, parameters, type=""):
                if "COUNT(*)" in query:
                    return ("count",), [(42,)]
                return (), []

        client = MagicMock()
        setup_mock_db_client(client, CustomQuery(), is_patch=False)

        result = client.query("SELECT COUNT(*) FROM jobs")
        assert result.result_rows == [(42,)]
    """

    if is_patch:
        mock_client = mock.return_value
    else:
        mock_client = mock

    mock_client.query.side_effect = (
        lambda query, parameters=None: mock_query.mock_query_result(
            query, parameters, query_type
        )
    )

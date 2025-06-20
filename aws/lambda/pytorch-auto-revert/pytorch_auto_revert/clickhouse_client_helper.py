import threading

import clickhouse_connect


class CHCliFactory:
    """
    Thread safe clickhose client singleton class
    """

    _lock = threading.Lock()

    @classmethod
    def setup_client(
        cls, host: str, port: int, username: str, password: str, database: str
    ) -> None:
        cls._host = host
        cls._port = port
        cls._username = username
        cls._password = password
        cls._database = database

    def __new__(cls):
        if not hasattr(cls, "_instance"):
            with cls._lock:
                # you might be wondering why we check for _instance again
                # after acquiring the lock. This is to ensure that only one
                # instance is created even if multiple threads are waiting
                # to create an instance at the same time.
                # and if it is already created, we don't need to wait for the lock
                # by checkig it first before acquiring the lock.
                if not hasattr(cls, "_instance"):
                    cls._instance = super(CHCliFactory, cls).__new__(cls)
        return cls._instance

    def __init__(self):
        # we only perform the expensive thread local storage initialization
        # once, when the instance is created.
        # this is faster, and maintain thread safety
        if hasattr(self, "_data"):
            return
        tlocal = threading.local()
        if not hasattr(tlocal, "_CHCliFactory_data"):
            tlocal._CHCliFactory_data = {}
        self._data = tlocal._CHCliFactory_data

    @property
    def client(self) -> clickhouse_connect.driver.Client:
        """Get ClickHouse client."""
        if "client" not in self._data:
            if (
                not hasattr(self, "_host")
                or not hasattr(self, "_port")
                or not hasattr(self, "_username")
                or not hasattr(self, "_password")
                or not hasattr(self, "_database")
            ):
                raise RuntimeError(
                    "ClickHouse client not configured. Call setup_client first."
                )

            self._data["client"] = clickhouse_connect.get_client(
                host=self._host,
                port=self._port,
                username=self._username,
                password=self._password,
                database=self._database,
                secure=True,
            )
        return self._data["client"]

    def connection_test(self) -> bool:
        """
        Test ClickHouse connection.

        Returns:
            bool: True if connection is successful, False otherwise.
        """
        try:
            self.client.query("SELECT 1")
            return True
        except Exception as e:
            print(f"Connection test failed: {e}")
            return False

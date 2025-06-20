import logging
import threading

import github


class GHClientFactory:
    """
    Thread safe github client singleton class
    """

    _lock = threading.Lock()

    @classmethod
    def setup_client(
        cls, app_id: str, app_secret: str, installation_id: int, token: str
    ) -> None:
        if app_id:
            cls._app_id = app_id
        if app_secret:
            cls._app_secret = app_secret
        if installation_id:
            cls._installation_id = installation_id
        if token:
            cls._token = token

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
                    cls._instance = super(GHClientFactory, cls).__new__(cls)
        return cls._instance

    def __init__(self):
        # we only perform the expensive thread local storage initialization
        # once, when the instance is created.
        # this is faster, and maintain thread safety
        tlocal = threading.local()
        if not hasattr(tlocal, "_GHClientFactory_data"):
            tlocal._GHClientFactory_data = {}
        self._data = tlocal._GHClientFactory_data

        self._logger = logging.getLogger(__name__)

    @property
    def token_auth_provided(self) -> bool:
        """
        Check if token authentication is provided.

        Returns:
            bool: True if token authentication is provided, False otherwise.
        """
        return hasattr(self, "_token")

    @property
    def key_auth_provided(self) -> bool:
        """
        Check if key authentication is provided.

        Returns:
            bool: True if key authentication is provided, False otherwise.
        """
        return (
            hasattr(self, "_app_id")
            and hasattr(self, "_app_secret")
            and hasattr(self, "_installation_id")
        )

    @property
    def client(self) -> github.Github:
        if "client" not in self._data:
            if self.token_auth_provided and not self.key_auth_provided:
                auth = github.Auth.Token(self._token)
            elif self.key_auth_provided and not self.token_auth_provided:
                auth = github.Auth.AppInstallationAuth(
                    github.Auth.AppAuth(
                        app_id=self._app_id,
                        app_secret=self._app_secret,
                    ),
                    installation_id=self._installation_id,
                )
            else:
                raise RuntimeError(
                    "GitHub client not properly configured. Call setup_client first."
                    + " Please note that you can only use one type of authentication at a time."
                )

            self._data["client"] = github.Github(auth=auth)
        return self._data["client"]

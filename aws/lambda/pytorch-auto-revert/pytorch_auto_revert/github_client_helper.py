import logging
import threading

import github


class GHClientFactory:
    """
    Thread safe github client singleton class
    """

    _lock = threading.Lock()

    @classmethod
    def setup_client(cls, *args, **kwargs) -> None:
        if "app_id" in kwargs:
            cls._app_id = kwargs.get("app_id")
        if "app_secret" in kwargs:
            cls._app_secret = kwargs.get("app_secret")
        if "installation_id" in kwargs:
            cls._installation_id = kwargs.get("installation_id")
        if "token" in kwargs:
            cls._token = kwargs.get("token")
        cls._validate_client_setup()

    @classmethod
    def _validate_client_setup(cls) -> None:
        if cls.token_auth_provided() and not cls._token:
            raise RuntimeError(
                "GitHub token authentication is provided, but no token is set."
            )
        if cls.key_auth_provided() and (
            not cls._app_id or not cls._app_secret or not cls._installation_id
        ):
            raise RuntimeError(
                "GitHub key authentication is provided, but no app ID, app secret, or installation ID is set."
            )
        if not cls.token_auth_provided() and not cls.key_auth_provided():
            raise RuntimeError(
                "GitHub client not properly configured. Call setup_client first."
                + " Please note that you can only use one type of authentication at a time."
            )

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

    @classmethod
    def token_auth_provided(cls) -> bool:
        """
        Check if token authentication is provided.

        Returns:
            bool: True if token authentication is provided, False otherwise.
        """
        return hasattr(cls, "_token")

    @classmethod
    def key_auth_provided(cls) -> bool:
        """
        Check if key authentication is provided.

        Returns:
            bool: True if key authentication is provided, False otherwise.
        """
        return (
            hasattr(cls, "_app_id")
            and hasattr(cls, "_app_secret")
            and hasattr(cls, "_installation_id")
        )

    @property
    def client(self) -> github.Github:
        if "client" not in self._data:
            if self.token_auth_provided():
                auth = github.Auth.Token(self._token)
            elif self.key_auth_provided():
                auth = github.Auth.AppInstallationAuth(
                    github.Auth.AppAuth(
                        app_id=self._app_id,
                        private_key=self._app_secret,
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

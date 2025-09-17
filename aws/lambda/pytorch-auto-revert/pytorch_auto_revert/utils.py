from enum import Enum


class RestartRevertAction(Enum):
    IGNORE = "ignore"
    DRY_RUN = "dry-run"
    RUN = "run"

    def __str__(self):
        return self.value

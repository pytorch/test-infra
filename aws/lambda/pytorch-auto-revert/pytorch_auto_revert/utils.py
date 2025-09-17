from enum import Enum


class RestartRevertAction(Enum):
    IGNORE = "ignore"
    DRY_RUN = "dry-run"
    RUN = "run"

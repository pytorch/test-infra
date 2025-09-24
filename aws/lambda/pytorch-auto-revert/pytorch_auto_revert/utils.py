from enum import Enum


class RestartAction(Enum):
    """Controls restart behavior.

    - SKIP: no logging, no side effects
    - LOG: read prod state, log intended actions (no side effects)
    - RUN: read prod state, dispatch restarts (side effects)
    """

    SKIP = "skip"
    LOG = "log"
    RUN = "run"

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.value

    @property
    def side_effects(self) -> bool:
        """True if this mode performs external side effects (GitHub dispatch)."""
        return self is RestartAction.RUN


class RevertAction(Enum):
    """Controls revert behavior.

    - SKIP: no logging, no side effects
    - LOG: read prod state, log revert intent only (no side effects)
    - RUN_LOG: read prod state, log revert intent with production dry-run flag (side effects limited to logging)
    - RUN_NOTIFY: read prod state, send notification (side effect) but no revert
    - RUN_REVERT: read prod state, perform revert (side effect)
    """

    SKIP = "skip"
    LOG = "log"
    RUN_LOG = "run-log"
    RUN_NOTIFY = "run-notify"
    RUN_REVERT = "run-revert"

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.value

    @property
    def side_effects(self) -> bool:
        """True if this mode performs external side effects or non-dry-run logging."""
        return self in (
            RevertAction.RUN_LOG,
            RevertAction.RUN_NOTIFY,
            RevertAction.RUN_REVERT,
        )

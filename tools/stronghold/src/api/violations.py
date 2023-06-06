from dataclasses import dataclass


@dataclass
class Violation:
    """Represents an API violation."""

    # The fully-qualified name of the function within the module.
    func: str

    # Where the violation occurred.
    line: int

    # A description of the violation.
    message: str


# ====================================
# Function violations
@dataclass
class FunctionDeleted(Violation):
    """Represents a public function being deleted

    Downstream users may rely on this public function, is it possible to create
    a shim in the interim?
    """

    message: str = 'function deleted'


# ====================================
# Generic argument violations
@dataclass
class VarArgsDeleted(Violation):
    """Represents when *varargs has been deleted"""

    message: str = '*varargs was removed'


@dataclass
class KwArgsDeleted(Violation):
    """Represents when **kwargs has been deleted"""

    message: str = '**kwargs was removed'


# ====================================
# Parameter violations
@dataclass
class ParameterViolation(Violation):
    # name of the parameter that was invovled in the violation
    parameter: str = ''


@dataclass
class ParameterRemoved(ParameterViolation):
    """Represents when a public function has a parameter that's been removed"""

    message: str = ''

    def __post_init__(self) -> None:
        self.message = f"{self.parameter} was removed"


@dataclass
class ParameterBecameRequired(ParameterViolation):
    """Represents when a public function has a parameter that became required"""

    message: str = ''

    def __post_init__(self) -> None:
        self.message = f'{self.parameter} became now required'


@dataclass
class ParameterNowRequired(ParameterViolation):
    """Represents when a public function has a parameter is now required"""

    message: str = ''

    def __post_init__(self) -> None:
        self.message = f'{self.parameter} was added and is now required'


@dataclass
class ParameterReordered(Violation):
    """Represents when a public function has a parameter that's been removed
    message: str = ''

    NOTE: This is not technically a ParameterViolation because no specific
          parameter name is needed
    """

    message: str = "positional parameters were reordered"


@dataclass
class ParameterRenamed(ParameterViolation):
    """Represents when a parameter has been renamed to a different parameter"""

    # Parameter after it was renamed
    parameter_after: str = ''

    message: str = ''

    def __post_init__(self) -> None:
        self.message = f'{self.parameter} was renamed to {self.parameter_after}'

@dataclass
class ParameterTypeChanged(ParameterViolation):
    """Represents when a parameter type has changed in a non-compatible way"""

    # Type before it was changed
    type_before: str = ''

    # Type after it was changed
    type_after: str = ''

    message: str = ''

    def __post_init__(self) -> None:
        self.message = f'{self.parameter} changed from {self.type_before} to {self.type_after}'

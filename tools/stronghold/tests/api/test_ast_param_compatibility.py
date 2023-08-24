"""Tests of the parameter types compatibility"""

from api.compatibility import _check_type_compatibility
from api.types import Attribute, Constant, Generic, TypeName, Unknown


def test_none() -> None:
    assert _check_type_compatibility(TypeName('int'), None) is True

    assert (
        _check_type_compatibility(
            None,
            TypeName('int'),
        )
        is True
    )

    assert (
        _check_type_compatibility(
            None,
            None,
        )
        is True
    )


def test_simple_types() -> None:
    assert (
        _check_type_compatibility(
            TypeName('int'),
            TypeName('int'),
        )
        is True
    )

    assert (
        _check_type_compatibility(
            TypeName('int'),
            TypeName('str'),
        )
        is False
    )

    assert (
        _check_type_compatibility(
            Attribute(
                value=TypeName('types'),
                attr='Test',
            ),
            Attribute(
                value=TypeName('types'),
                attr='Test',
            ),
        )
        is True
    )

    assert (
        _check_type_compatibility(
            Attribute(
                value=TypeName('types'),
                attr='Test',
            ),
            Attribute(
                value=TypeName('types'),
                attr='Test2',
            ),
        )
        is False
    )


def test_unknown_types() -> None:
    assert (
        _check_type_compatibility(
            TypeName('int'),
            Unknown('?'),
        )
        is True
    )

    assert (
        _check_type_compatibility(
            Unknown('?'),
            TypeName('int'),
        )
        is True
    )


def test_constant_types() -> None:
    assert (
        _check_type_compatibility(
            Constant('None'),
            Constant('None'),
        )
        is True
    )

    assert (
        _check_type_compatibility(
            Constant('None'),
            Constant('True'),
        )
        is False
    )

    assert (
        _check_type_compatibility(
            Constant('None'),
            Constant('False'),
        )
        is False
    )

    assert (
        _check_type_compatibility(
            Constant('True'),
            TypeName('bool'),
        )
        is True
    )

    # note: asymmetry
    assert (
        _check_type_compatibility(
            TypeName('bool'),
            Constant('True'),
        )
        is False
    )

    # note: not aware of the actual type
    # thus it is compatible with any type
    assert (
        _check_type_compatibility(
            Constant('True'),
            TypeName('int'),
        )
        is True
    )


def test_generic_types() -> None:
    assert (
        _check_type_compatibility(
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('int')],
            ),
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('int')],
            ),
        )
        is True
    )

    assert (
        _check_type_compatibility(
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('int')],
            ),
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('str')],
            ),
        )
        is False
    )

    assert (
        _check_type_compatibility(
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('int')],
            ),
            Generic(
                base=TypeName('Tuple'),
                arguments=[TypeName('int')],
            ),
        )
        is False
    )

    assert (
        _check_type_compatibility(
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('int'), TypeName('str')],
            ),
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('str'), TypeName('int')],
            ),
        )
        is False
    )

    assert (
        _check_type_compatibility(
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('int'), TypeName('str')],
            ),
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('int'), TypeName('str')],
            ),
        )
        is True
    )

    assert (
        _check_type_compatibility(
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('int'), TypeName('str')],
            ),
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('int')],
            ),
        )
        is False
    )

    assert (
        _check_type_compatibility(
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('int')],
            ),
            Generic(
                base=TypeName('List'),
                arguments=[Unknown('?')],
            ),
        )
        is True
    )

    assert (
        _check_type_compatibility(
            Generic(
                base=TypeName('List'),
                arguments=[Unknown('?')],
            ),
            Generic(
                base=TypeName('List'),
                arguments=[TypeName('int')],
            ),
        )
        is True
    )

    # recursive types
    assert (
        _check_type_compatibility(
            Generic(
                base=TypeName('List'),
                arguments=[
                    Generic(
                        base=TypeName('List'),
                        arguments=[TypeName('int')],
                    )
                ],
            ),
            Generic(
                base=TypeName('List'),
                arguments=[
                    Generic(
                        base=TypeName('List'),
                        arguments=[TypeName('int')],
                    )
                ],
            ),
        )
        is True
    )

    assert (
        _check_type_compatibility(
            Generic(
                base=TypeName('List'),
                arguments=[
                    Generic(
                        base=TypeName('List'),
                        arguments=[TypeName('int')],
                    )
                ],
            ),
            Generic(
                base=TypeName('List'),
                arguments=[
                    Generic(
                        base=TypeName('List'),
                        arguments=[TypeName('str')],
                    )
                ],
            ),
        )
        is False
    )

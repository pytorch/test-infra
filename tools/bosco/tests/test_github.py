import bosco.github


def test_repository() -> None:
    assert str(bosco.github.Repository('pytorch', 'test-infra')) == 'pytorch/test-infra'

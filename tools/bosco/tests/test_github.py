import bosco.github


def test_repository() -> None:
    assert str(bosco.github.Repository('pytorch', 'test-infra')) == 'pytorch/test-infra'


def test_url() -> None:
    pr = bosco.github.PR(bosco.github.Repository('org', 'name'), 777)
    assert pr.url == 'https://github.com/org/name/pull/777'

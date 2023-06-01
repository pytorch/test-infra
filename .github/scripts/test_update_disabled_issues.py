from unittest import main, mock, TestCase

from update_disabled_issues import (
    condense_disable_jobs,
    condense_disable_tests,
    filter_disable_issues,
    get_disable_issues,
    OWNER,
    REPO,
    UNSTABLE_PREFIX,
    validate_and_sort,
)


MOCK_DATA = {
    "total_count": 6,
    "incomplete_results": False,
    "items": [
        {
            "html_url": "https://github.com/pytorch/pytorch/issues/32644",
            "url": "https://api.github.com/repos/pytorch/pytorch/issues/32644",
            "number": 32644,
            "title": "DISABLED test_quantized_rnn (test_quanization.PostTrainingDynamicQuantTest)",
            "body": "Platforms: linux, rocm\n\nThis test was disabled because it is failing in CI.",
        },
        {
            "html_url": "https://github.com/pytorch/pytorch/issues/67289",
            "url": "https://api.github.com/repos/pytorch/pytorch/issues/67289",
            "number": 67289,
            "title": "DISABLED test_zero_redundancy_optimizer (__main__.TestZeroRedundancyOptimizerDistributed)",
            "body": "",
        },
        {
            "html_url": "https://github.com/pytorch/pytorch/issues/94861",
            "url": "https://api.github.com/repos/pytorch/pytorch/issues/94861",
            "number": 94861,
            "title": "DISABLED pull / linux-bionic-py3.8-clang9 / test (dynamo)",
            "user": {
                "login": "mock-user",
            },
        },
        {
            "html_url": "https://github.com/pytorch/pytorch/issues/42345",
            "url": "https://api.github.com/repos/pytorch/pytorch/issues/42345",
            "number": 42345,
            "title": "DISABLED pull / linux-bionic-py3.8-clang9",
            "user": {
                "login": "mock-user",
            },
        },
        {
            "html_url": "https://github.com/pytorch/pytorch/issues/32132",
            "url": "https://api.github.com/repos/pytorch/pytorch/issues/32132",
            "number": 32132,
            "title": "DISABLED pull",
            "user": {
                "login": "mock-user",
            },
        },
        {
            "html_url": "https://github.com/pytorch/pytorch/issues/53457",
            "url": "https://api.github.com/repos/pytorch/pytorch/issues/53457",
            "number": 53457,
            "title": "Not a DISABLED issue, but has the disabled keyword",
        },
    ],
}

MOCK_UNSTABLE_DATA = {
    "total_count": 3,
    "incomplete_results": False,
    "items": [
        {
            "html_url": "https://github.com/pytorch/pytorch/issues/102299",
            "url": "https://api.github.com/repos/pytorch/pytorch/issues/102299",
            "number": 102299,
            "title": "UNSTABLE trunk / macos-12-py3-arm64",
            "user": {
                "login": "mock-user",
            },
        },
        {
            "html_url": "https://github.com/pytorch/pytorch/issues/102300",
            "url": "https://api.github.com/repos/pytorch/pytorch/issues/102300",
            "number": 102300,
            "title": "UNSTABLE windows-binary-libtorch-release",
            "user": {
                "login": "mock-user",
            },
        },
        {
            "html_url": "https://github.com/pytorch/pytorch/issues/53457",
            "url": "https://api.github.com/repos/pytorch/pytorch/issues/53457",
            "number": 53457,
            "title": "Not a UNSTABLE issue, but has the unstable keyword",
        },
    ],
}


@mock.patch("test_update_disabled_issues.get_disable_issues")
class TestUpdateDisabledIssues(TestCase):
    def test_validate_and_sort(self, mock_get_disable_issues):
        mock_get_disable_issues.return_value = MOCK_DATA

        disabled_issues = get_disable_issues()
        validate_and_sort(disabled_issues)

        items = disabled_issues["items"]
        # Check that the list of issues is sorted
        for i in range(len(items) - 1):
            self.assertTrue(items[i]["number"] <= items[i + 1]["number"])

    def test_filter_disable_issues(self, mock_get_disable_issues):
        mock_get_disable_issues.return_value = MOCK_DATA

        disabled_issues = get_disable_issues()
        validate_and_sort(disabled_issues)

        disabled_tests, disabled_jobs = filter_disable_issues(disabled_issues)
        self.assertListEqual(
            [item["number"] for item in disabled_tests], [32644, 67289]
        )
        self.assertListEqual(
            [item["number"] for item in disabled_jobs], [32132, 42345, 94861]
        )

    def test_condense_disable_tests(self, mock_get_disable_issues):
        mock_get_disable_issues.return_value = MOCK_DATA

        disabled_issues = get_disable_issues()
        validate_and_sort(disabled_issues)

        disabled_tests, _ = filter_disable_issues(disabled_issues)
        results = condense_disable_tests(disabled_tests)

        self.assertDictEqual(
            {
                "test_quantized_rnn (test_quanization.PostTrainingDynamicQuantTest)": (
                    "32644",
                    "https://github.com/pytorch/pytorch/issues/32644",
                    [
                        "linux",
                        "rocm",
                    ],
                ),
                "test_zero_redundancy_optimizer (__main__.TestZeroRedundancyOptimizerDistributed)": (
                    "67289",
                    "https://github.com/pytorch/pytorch/issues/67289",
                    [],
                ),
            },
            results,
        )

    def test_condense_disable_jobs(self, mock_get_disable_issues):
        mock_get_disable_issues.return_value = MOCK_DATA

        disabled_issues = get_disable_issues()
        validate_and_sort(disabled_issues)

        _, disabled_jobs = filter_disable_issues(disabled_issues)

        with mock.patch(
            "update_disabled_issues.can_disable_jobs"
        ) as mock_can_disable_jobs:
            mock_can_disable_jobs.return_value = True
            results = condense_disable_jobs(
                disable_issues=disabled_jobs, owner=OWNER, repo=REPO
            )

        self.assertDictEqual(
            {
                "pull": (
                    "mock-user",
                    "32132",
                    "https://github.com/pytorch/pytorch/issues/32132",
                    "pull",
                    "",
                    "",
                ),
                "pull / linux-bionic-py3.8-clang9": (
                    "mock-user",
                    "42345",
                    "https://github.com/pytorch/pytorch/issues/42345",
                    "pull",
                    "linux-bionic-py3.8-clang9",
                    "",
                ),
                "pull / linux-bionic-py3.8-clang9 / test (dynamo)": (
                    "mock-user",
                    "94861",
                    "https://github.com/pytorch/pytorch/issues/94861",
                    "pull",
                    "linux-bionic-py3.8-clang9",
                    "test (dynamo)",
                ),
            },
            results,
        )

    def test_unstable_jobs(self, mock_get_disable_issues):
        mock_get_disable_issues.return_value = MOCK_UNSTABLE_DATA

        unstable_issues = get_disable_issues(prefix=UNSTABLE_PREFIX)
        validate_and_sort(unstable_issues)

        _, unstable_jobs = filter_disable_issues(
            unstable_issues, prefix=UNSTABLE_PREFIX
        )

        with mock.patch(
            "update_disabled_issues.can_disable_jobs"
        ) as mock_can_disable_jobs:
            mock_can_disable_jobs.return_value = True
            results = condense_disable_jobs(
                unstable_jobs,
                owner=OWNER,
                repo=REPO,
                prefix=UNSTABLE_PREFIX,
            )

        self.assertDictEqual(
            {
                "trunk / macos-12-py3-arm64": (
                    "mock-user",
                    "102299",
                    "https://github.com/pytorch/pytorch/issues/102299",
                    "trunk",
                    "macos-12-py3-arm64",
                    "",
                ),
                "windows-binary-libtorch-release": (
                    "mock-user",
                    "102300",
                    "https://github.com/pytorch/pytorch/issues/102300",
                    "windows-binary-libtorch-release",
                    "",
                    "",
                ),
            },
            results,
        )

    def test_unauthorized_condense_disable_jobs(self, mock_get_disable_issues):
        mock_get_disable_issues.return_value = MOCK_DATA

        disabled_issues = get_disable_issues()
        validate_and_sort(disabled_issues)

        _, disabled_jobs = filter_disable_issues(disabled_issues)

        with mock.patch(
            "update_disabled_issues.can_disable_jobs"
        ) as mock_can_disable_jobs:
            mock_can_disable_jobs.return_value = False
            results = condense_disable_jobs(
                disable_issues=disabled_jobs, owner=OWNER, repo=REPO
            )

        # Nothing should be disabled here because of the lack of permission
        self.assertFalse(results)

    def test_unauthorized_unstable_jobs(self, mock_get_disable_issues):
        mock_get_disable_issues.return_value = MOCK_UNSTABLE_DATA

        unstable_issues = get_disable_issues(MOCK_UNSTABLE_DATA)
        validate_and_sort(unstable_issues)

        _, unstable_jobs = filter_disable_issues(
            unstable_issues, prefix=UNSTABLE_PREFIX
        )

        with mock.patch(
            "update_disabled_issues.can_disable_jobs"
        ) as mock_can_disable_jobs:
            mock_can_disable_jobs.return_value = False
            results = condense_disable_jobs(
                unstable_jobs, owner=OWNER, repo=REPO, prefix=UNSTABLE_PREFIX
            )

        # Nothing should be masked as unstable here because of the lack of permission
        self.assertFalse(results)


if __name__ == "__main__":
    main()

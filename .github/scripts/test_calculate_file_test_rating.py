from calculate_file_test_rating import calculate_ratings, filter_tests
from unittest import main, TestCase


class TestCalculateFileTestRating(TestCase):
    def gen_test(
        self,
        invoking_file="invoking_file",
        name="test_name",
        classname="classname",
        file="file",
        head_sha="head_sha",
    ):
        return {
            "invoking_file": invoking_file,
            "name": name,
            "classname": classname,
            "file": file,
            "head_sha": head_sha,
        }

    def gen_merge_base(self, sha, changed_files, merge_base):
        return (
            sha,
            {
                "changed_files": changed_files,
                "sha": sha,
                "merge_base": merge_base,
            },
        )

    def test_calculate_rating(self):
        # Extrememly simple sanity checks
        tests = [
            self.gen_test(head_sha="head_sha_1"),
            self.gen_test(head_sha="head_sha_2"),
        ]
        merge_bases = dict(
            [
                self.gen_merge_base("head_sha_1", ["a.txt", "b.txt"], "merge_base_1"),
                self.gen_merge_base("head_sha_2", ["a.txt"], "merge_base_2"),
            ]
        )
        expected = {"a.txt": {"invoking_file": 1.5}, "b.txt": {"invoking_file": 0.5}}
        scores = calculate_ratings(tests, merge_bases)
        self.assertDictEqual(scores, expected)

        tests = [
            self.gen_test(invoking_file="invoking_file_1"),
            self.gen_test(invoking_file="invoking_file_2"),
        ]
        merge_bases = dict(
            [
                self.gen_merge_base("head_sha", ["a.txt", "b.txt"], "merge_base_1"),
            ]
        )
        expected = {
            "a.txt": {"invoking_file_1": 0.5, "invoking_file_2": 0.5},
            "b.txt": {"invoking_file_1": 0.5, "invoking_file_2": 0.5},
        }
        scores = calculate_ratings(tests, merge_bases)
        self.assertDictEqual(scores, expected)

    def test_filter_tests(self):
        tests = [
            self.gen_test(head_sha="head_sha"),
            self.gen_test(head_sha="merge_base"),
        ]
        merge_bases = dict(
            [
                self.gen_merge_base("head_sha", [], "merge_base"),
                self.gen_merge_base("merge_base", [], "merge_base_2"),
            ]
        )
        filtered = filter_tests(tests, merge_bases)
        self.assertTrue(len(filtered), 1)
        self.assertDictEqual(filtered[0], tests[1])


if __name__ == "__main__":
    main()

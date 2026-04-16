import sys
import unittest
from datetime import datetime, timezone


# Ensure package import when running from repo root
sys.path.insert(0, "aws/lambda/pytorch-auto-revert")

from pytorch_auto_revert.utils import parse_datetime  # noqa: E402


class TestParseDatetime(unittest.TestCase):
    def test_iso8601_with_seconds(self):
        result = parse_datetime("2025-12-18T15:31:45")
        expected = datetime(2025, 12, 18, 15, 31, 45, tzinfo=timezone.utc)
        self.assertEqual(result, expected)

    def test_iso8601_without_seconds(self):
        result = parse_datetime("2025-12-18T15:31")
        expected = datetime(2025, 12, 18, 15, 31, 0, tzinfo=timezone.utc)
        self.assertEqual(result, expected)

    def test_space_separated_with_seconds(self):
        result = parse_datetime("2025-12-18 15:31:45")
        expected = datetime(2025, 12, 18, 15, 31, 45, tzinfo=timezone.utc)
        self.assertEqual(result, expected)

    def test_space_separated_without_seconds(self):
        result = parse_datetime("2025-12-18 15:31")
        expected = datetime(2025, 12, 18, 15, 31, 0, tzinfo=timezone.utc)
        self.assertEqual(result, expected)

    def test_date_only(self):
        result = parse_datetime("2025-12-18")
        expected = datetime(2025, 12, 18, 0, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(result, expected)

    def test_result_is_utc_aware(self):
        result = parse_datetime("2025-12-18T15:31")
        self.assertIsNotNone(result.tzinfo)
        self.assertEqual(result.tzinfo, timezone.utc)

    def test_invalid_format_raises_valueerror(self):
        with self.assertRaises(ValueError) as ctx:
            parse_datetime("not-a-date")
        self.assertIn("Cannot parse datetime", str(ctx.exception))

    def test_partial_date_raises_valueerror(self):
        with self.assertRaises(ValueError):
            parse_datetime("2025-12")

    def test_empty_string_raises_valueerror(self):
        with self.assertRaises(ValueError):
            parse_datetime("")

    def test_midnight_boundary(self):
        result = parse_datetime("2025-01-01T00:00:00")
        expected = datetime(2025, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(result, expected)

    def test_end_of_day(self):
        result = parse_datetime("2025-12-31T23:59:59")
        expected = datetime(2025, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
        self.assertEqual(result, expected)


if __name__ == "__main__":
    unittest.main()

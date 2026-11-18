import logging
import sys
import unittest


# Ensure package import when running from repo root
sys.path.insert(0, "aws/lambda/pytorch-auto-revert")

from pytorch_auto_revert.__main__ import AWS_SDK_LOGGERS, setup_logging  # noqa: E402


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


class TestSetupLogging(unittest.TestCase):
    def setUp(self):
        root = logging.getLogger()
        self._saved = (
            root.level,
            list(root.handlers),
            {n: logging.getLogger(n).level for n in AWS_SDK_LOGGERS},
        )
        self.capture = _Capture()
        root.handlers = [self.capture]

    def tearDown(self):
        level, handlers, sdk_levels = self._saved
        root = logging.getLogger()
        root.setLevel(level)
        root.handlers = handlers
        for name, sdk_level in sdk_levels.items():
            logging.getLogger(name).setLevel(sdk_level)

    def test_debug_keeps_app_debug_but_drops_botocore_bodies(self):
        setup_logging("DEBUG")
        logging.getLogger("pytorch_auto_revert.x").debug("app debug")
        # botocore.parsers logs the raw response body at DEBUG.
        logging.getLogger("botocore.parsers").debug("Response body: ...")
        logging.getLogger("botocore.credentials").info("Found credentials")
        self.assertIn("app debug", self.capture.messages)
        self.assertNotIn("Response body: ...", self.capture.messages)
        self.assertIn("Found credentials", self.capture.messages)

    def test_higher_level_applies_to_aws_sdk_too(self):
        setup_logging("WARNING")
        logging.getLogger("botocore.endpoint").info("Sending http request")
        self.assertEqual([], self.capture.messages)


if __name__ == "__main__":
    unittest.main()

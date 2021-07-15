# Copyright (c) 2019-present, Facebook, Inc.

import base64
import bz2
import os
import unittest
from unittest.mock import ANY, Mock, patch

import scribe_proxy


class TestScribeProxy(unittest.TestCase):
    @patch.dict(os.environ, {'SCRIBE_GRAPHQL_ACCESS_TOKEN': '123'}, clear=True)
    @patch('scribe_proxy.urlopen')
    def test_logs(self, mock_urlopen):
        event = {'logs': 'logs'}
        scribe_proxy.lambda_handler(event, Mock())
        mock_urlopen.assert_called_once_with(
            ANY,
            data=b'{"access_token": "123", "logs": "logs"}',
        )

    @patch.dict(os.environ, {'SCRIBE_GRAPHQL_ACCESS_TOKEN': '123'}, clear=True)
    @patch('scribe_proxy.urlopen')
    def test_base64_bz2_logs(self, mock_urlopen):
        event = {'base64_bz2_logs': base64.b64encode(
            bz2.compress('logs'.encode())).decode()}
        scribe_proxy.lambda_handler(event, Mock())
        mock_urlopen.assert_called_once_with(
            ANY,
            data=b'{"access_token": "123", "logs": "logs"}',
        )

    def test_invalid_events(self):
        with self.assertRaises(Exception):
            event = {'invalid': '123'}
            scribe_proxy.lambda_handler(event, Mock())

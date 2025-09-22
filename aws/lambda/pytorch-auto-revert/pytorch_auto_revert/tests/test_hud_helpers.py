import json

import pytest
from pytorch_auto_revert.testers.hud import default_hud_filename, get_state_timestamp


def test_default_hud_filename_sanitizes_colons_and_spaces():
    assert default_hud_filename("2025-09-22 18:59:14") == "2025-09-22_18-59-14.html"


def test_default_hud_filename_rejects_blank_input():
    with pytest.raises(ValueError):
        default_hud_filename("   ")


def test_get_state_timestamp_from_mapping():
    state = {"meta": {"ts": "2025-09-22T18:59:14"}}
    assert get_state_timestamp(state) == "2025-09-22T18:59:14"


def test_get_state_timestamp_from_json_string():
    state_json = json.dumps({"meta": {"ts": "2025-09-22T18:59:14"}})
    assert get_state_timestamp(state_json) == "2025-09-22T18:59:14"


def test_get_state_timestamp_missing_value():
    with pytest.raises(ValueError):
        get_state_timestamp({"meta": {}})

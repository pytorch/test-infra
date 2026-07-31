import csv
import io

import pytest
from flake_test_fail_autorevert.report.load import (
    EXPECTED_COLUMNS,
    load_records,
    ReportInputError,
)


HEADER = ",".join(EXPECTED_COLUMNS)


def _row(
    sha="a" * 40,
    time="2026-07-01 10:00:00",
    category="flaky",
    workflow="wf",
    signal="f.py::t",
    verdict="",
    confidence="",
    premerge="",
):
    url = f"https://github.com/pytorch/pytorch/commit/{sha}"
    buf = io.StringIO()
    csv.writer(buf).writerow(
        [sha, url, time, category, workflow, signal, verdict, confidence, premerge]
    )
    return buf.getvalue().rstrip("\r\n")


def test_valid_csv_parses_to_records():
    lines = [HEADER, _row(), _row(category="regression", verdict="related")]
    records = load_records(lines)
    assert len(records) == 2
    assert records[0].category == "flaky"
    assert records[0].signal_key == "f.py::t"
    assert records[0].day == "2026-07-01"
    assert records[1].category == "regression"
    assert records[1].advisor_verdict == "related"


def test_header_only_yields_empty_records():
    assert load_records([HEADER]) == []


def test_empty_input_raises():
    with pytest.raises(ReportInputError) as exc:
        load_records([])
    assert "empty" in str(exc.value).lower()


def test_wrong_header_raises_clean_error():
    bad = "commit_sha,commit_url,commit_time,regressions,flaky_signals"
    with pytest.raises(ReportInputError) as exc:
        load_records([bad, "x,y,z,q,r"])
    msg = str(exc.value)
    assert "Unexpected CSV header" in msg
    assert "expected:" in msg


def test_missing_column_in_header_raises():
    short = ",".join(EXPECTED_COLUMNS[:-1])
    with pytest.raises(ReportInputError):
        load_records([short])


def test_extra_column_in_header_raises():
    extra = HEADER + ",surprise"
    with pytest.raises(ReportInputError):
        load_records([extra])


def test_wrong_column_count_in_data_row_raises():
    lines = [HEADER, "only,three,cols"]
    with pytest.raises(ReportInputError) as exc:
        load_records(lines)
    assert "columns" in str(exc.value)


def test_blank_lines_are_skipped():
    lines = [HEADER, "", _row(), "   "]
    records = load_records(lines)
    assert len(records) == 1


def test_quoted_field_with_comma_parses_as_one_column():
    signal = "f.py::t[param, with comma]"
    lines = [HEADER, _row(signal=signal)]
    records = load_records(lines)
    assert records[0].signal_key == signal


def test_multiline_quoted_field_preserved_via_stream():
    signal = "f.py::t[line1\nline2]"
    csv_text = HEADER + "\n" + _row(signal=signal) + "\n"
    records = load_records(io.StringIO(csv_text))
    assert len(records) == 1
    assert records[0].signal_key == signal


def test_very_long_signal_key_does_not_raise():
    signal = "f.py::t[" + "x" * 200000 + "]"
    csv_text = HEADER + "\n" + _row(signal=signal) + "\n"
    records = load_records(io.StringIO(csv_text))
    assert records[0].signal_key == signal


def test_malformed_csv_raises_clean_error():
    csv_text = HEADER + "\n" + '"unterminated quote,field\n'
    with pytest.raises(ReportInputError):
        load_records(io.StringIO(csv_text))

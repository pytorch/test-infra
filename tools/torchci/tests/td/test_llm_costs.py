import json
import struct
import sys
import tempfile
from pathlib import Path
from subprocess import CalledProcessError
from unittest import main, TestCase

from torchci.td.llm import costs


class CostsTest(TestCase):
    def test_count_parameters_reads_safetensors_headers(self) -> None:
        header = {"a": {"shape": [2, 3]}, "b": {"shape": [4]}, "__metadata__": {}}
        blob = json.dumps(header).encode()
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "model.safetensors").write_bytes(
                struct.pack("<Q", len(blob)) + blob
            )
            self.assertEqual(costs.count_parameters(Path(tmp)), 10)

    def test_probe_reads_the_last_line_and_checks_the_exit_status(self) -> None:
        printing = [sys.executable, "-c", "print('noise'); print('{\"seconds\": 1.5}')"]
        self.assertEqual(costs._probe(printing), {"seconds": 1.5})
        with self.assertRaises(CalledProcessError):
            costs._probe([sys.executable, "-c", "import sys; sys.exit(2)"])

    def test_measure_needs_diffs(self) -> None:
        with self.assertRaises(ValueError):
            costs.measure(Path("."), None, None, [], "", Path("."), [], 1)  # type: ignore[arg-type]


if __name__ == "__main__":
    main()

import hashlib
import io
import tarfile
import tempfile
import unittest
from pathlib import Path

from tools.linter.adapters import s3_init


class LinterDownloadTest(unittest.TestCase):
    def test_archive_and_executable_hashes_are_checked_before_install(self):
        binary = b"test executable"
        for archive_valid, binary_valid in ((True, True), (False, True), (True, False)):
            with self.subTest(archive_valid=archive_valid, binary_valid=binary_valid):
                with tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    source = root / "release.tar.gz"
                    with tarfile.open(source, "w:gz") as archive:
                        member = tarfile.TarInfo("actionlint")
                        member.size = len(binary)
                        archive.addfile(member, io.BytesIO(binary))
                    archive_hash = s3_init.compute_file_sha256(str(source))
                    binary_hash = hashlib.sha256(binary).hexdigest()
                    args = (
                        "actionlint",
                        str(root / "install"),
                        source.as_uri(),
                        binary_hash if binary_valid else "0" * 64,
                        archive_hash if archive_valid else "0" * 64,
                        "actionlint",
                    )
                    target = root / "install/actionlint"
                    if archive_valid and binary_valid:
                        self.assertTrue(s3_init.download(*args))
                        self.assertEqual(target.read_bytes(), binary)
                        self.assertTrue(target.stat().st_mode & 0o100)
                    else:
                        with self.assertRaises(ValueError):
                            s3_init.download(*args)
                        self.assertFalse(target.exists())

    def test_raw_binary_download_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "binary"
            source.write_bytes(b"original binary")
            self.assertTrue(
                s3_init.download(
                    "tool",
                    str(root / "install"),
                    source.as_uri(),
                    s3_init.compute_file_sha256(str(source)),
                )
            )
            self.assertEqual((root / "install/tool").read_bytes(), source.read_bytes())

"""Regression checks for narrow revision-checked 0.6B workaround."""
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from patch_sft import OLD, NEW, PIN, make_patched


class PatchTest(unittest.TestCase):
    def test_patches_one_projection_and_compiles(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            src = root / "upstream/finetuning/sft_12hz.py"
            src.parent.mkdir(parents=True)
            src.write_text("def run():\n    " + OLD + "\n")
            target = root / "patched.py"
            with patch("subprocess.run") as runner:
                runner.return_value = subprocess.CompletedProcess([], 0, stdout=PIN + "\n")
                make_patched(src, target)
            self.assertIn(NEW, target.read_text())
            with self.assertRaisesRegex(ValueError, "exists"):
                with patch("subprocess.run") as runner:
                    runner.return_value = subprocess.CompletedProcess([], 0, stdout=PIN + "\n")
                    make_patched(src, target)

    def test_rejects_unknown_revision(self):
        with tempfile.TemporaryDirectory() as temp:
            src = pathlib.Path(temp) / "upstream/finetuning/sft_12hz.py"
            src.parent.mkdir(parents=True)
            src.write_text("def run():\n    " + OLD + "\n")
            with patch("subprocess.run") as runner:
                runner.return_value = subprocess.CompletedProcess([], 0, stdout="0" * 40)
                with self.assertRaisesRegex(ValueError, "unsupported"):
                    make_patched(src, src.parent / "copy.py")


if __name__ == "__main__":
    unittest.main()

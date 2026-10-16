"""Audio inventory tests: generated silence only, no private recordings."""
import csv
import json
import pathlib
import sys
import tempfile
import unittest
import wave
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from inventory_audio import inventory, probe_audio, save_template, summarize


def wav(path, seconds, rate=24000, channels=1):
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"\0\0" * (seconds * rate * channels))


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        wav(self.raw / "short.wav", 0)
        wav(self.raw / "ready.wav", 2)
        wav(self.raw / "long.wav", 21)
        (self.raw / "invalid.wav").write_bytes(b"not a wave")

    def test_probe_wav_and_inventory(self):
        self.assertEqual(probe_audio(self.raw / "ready.wav"), (2.0, 24000, 1))
        rows = inventory(self.raw)
        self.assertEqual({x["file"]: x["status"] for x in rows},
                         {"short.wav": "INVALID", "ready.wav": "READY",
                          "long.wav": "LONG", "invalid.wav": "INVALID"})
        summary = summarize(rows)
        self.assertEqual(summary["recordings"], 4)
        self.assertEqual(summary["ready_clips"], 1)
        self.assertEqual(summary["long_clips"], 1)
        self.assertEqual(summary["invalid_clips"], 2)

    def test_template_is_blank_and_immutable(self):
        rows = inventory(self.raw)
        target = self.root / "transcripts.csv"
        self.assertEqual(save_template(rows, target), 4)
        with target.open(encoding="utf-8-sig", newline="") as file:
            content = list(csv.DictReader(file))
        self.assertEqual(content[0]["text"], "")
        self.assertEqual(len(content), 4)
        before = target.read_bytes()
        with self.assertRaisesRegex(ValueError, "exists"):
            save_template(rows, target)
        self.assertEqual(target.read_bytes(), before)

    def test_symlink_outside_source_not_followed(self):
        outside = self.root / "outside.wav"
        wav(outside, 2)
        (self.raw / "linked.wav").symlink_to(outside)
        names = {r["file"] for r in inventory(self.raw)}
        self.assertNotIn("linked.wav", names)

    def test_probe_ffprobe_metadata_and_failure(self):
        path = self.raw / "voice.mp3"
        path.write_bytes(b"fake")
        stdout = json.dumps({"format": {"duration": "2.3"}, "streams": [
            {"codec_type": "audio", "sample_rate": "44100", "channels": 2}]})
        from subprocess import CompletedProcess
        with patch("inventory_audio.subprocess.run",
                   return_value=CompletedProcess([], 0, stdout=stdout)):
            self.assertEqual(probe_audio(path), (2.3, 44100, 2))
        with patch("inventory_audio.subprocess.run",
                   return_value=CompletedProcess([], 1, stdout="", stderr="")):
            with self.assertRaisesRegex(ValueError, "ffprobe failed"):
                probe_audio(path)


if __name__ == "__main__":
    unittest.main()

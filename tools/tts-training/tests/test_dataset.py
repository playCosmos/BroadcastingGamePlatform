"""Offline stdlib-only tests; never download checkpoints or touch private voices."""
import csv
import pathlib
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from prepare_dataset import build_dataset, entries_from_csv, split_entries


class DatasetTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        with (self.raw / "transcripts.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            writer.writerow(["file", "text"])
            for i in range(12):
                file = f"clip_{i}.wav"
                with wave.open(str(self.raw / file), "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(24000)
                    wav.writeframes(b"\0\0" * (24000 * 2))
                writer.writerow([file, f"안녕하세요. 대본 문장 {i}"])

    def test_dataset_deterministic_and_disjoint(self):
        items = entries_from_csv(self.raw, self.raw / "transcripts.csv")
        a, b = split_entries(items, .2, 42)
        c, d = split_entries(items, .2, 42)
        self.assertEqual([x["path"] for x in a], [x["path"] for x in c])
        self.assertEqual([x["path"] for x in b], [x["path"] for x in d])
        self.assertFalse({x["path"] for x in a} & {x["path"] for x in b})
        result = build_dataset(self.raw, self.raw / "transcripts.csv",
                               self.root / "prepared", ratio=.2)
        self.assertEqual(result["train_utterances"] + result["validation_utterances"], 12)
        import json
        train = [json.loads(x) for x in
                 (self.root / "prepared/train_raw.jsonl").read_text().splitlines()]
        val = [json.loads(x) for x in
               (self.root / "prepared/validation_raw.jsonl").read_text().splitlines()]
        self.assertEqual(len(train), 10)
        self.assertEqual(len(val), 2)
        self.assertEqual({x["ref_audio"] for x in train + val}.__len__(), 1)
        self.assertTrue(all(pathlib.Path(x["audio"]).exists() for x in train + val))
        self.assertFalse({x["audio"] for x in train} & {x["audio"] for x in val})
        with self.assertRaisesRegex(ValueError, "not empty"):
            build_dataset(self.raw, self.raw / "transcripts.csv",
                          self.root / "prepared", ratio=.2)

    def test_dry_run_no_side_effects(self):
        output = self.root / "prepared"
        result = build_dataset(self.raw, self.raw / "transcripts.csv", output,
                               dry_run=True)
        self.assertTrue(result["dry_run"])
        self.assertFalse(output.exists())

    def test_traversal_and_missing_transcripts_rejected(self):
        with (self.raw / "transcripts.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            writer.writerow(["file", "text"])
            writer.writerow(["../outside.wav", "escape"])
            for i in range(3):
                writer.writerow([f"clip_{i}.wav", "valid"])
        with self.assertRaises(OSError):
            entries_from_csv(self.raw, self.raw / "transcripts.csv")

    def test_duplicates_rejected(self):
        with (self.raw / "transcripts.csv").open("a", newline="", encoding="utf-8") as stream:
            csv.writer(stream).writerow(["clip_1.wav", "duplicate"])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            entries_from_csv(self.raw, self.raw / "transcripts.csv")


if __name__ == "__main__":
    unittest.main()

import importlib.util
import pathlib
import sys
import unittest

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("public_sources", pathlib.Path(__file__).with_name("collect-public-sources.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class AcquisitionSafetyTests(unittest.TestCase):
    def test_shallow_boundary_cannot_supply_document_dates(self):
        history = "@@recent 2026-10-26T00:00:00Z\n\ndocs/changed.md\n@@boundary 2026-10-23T00:00:00Z\n\ndocs/changed.md\ndocs/unproven.md\n"
        result = collector.updated_files(history, {"boundary"})
        self.assertEqual(set(result), {"docs/changed.md"})
        self.assertEqual(result["docs/changed.md"][0], "recent")

    def test_latest_proven_change_wins_over_older_history(self):
        history = "@@new 2026-10-26T00:00:00Z\ndocs/a.md\n@@old 2026-10-20T00:00:00Z\ndocs/a.md\ndocs/b.md\n"
        result = collector.updated_files(history, set())
        self.assertEqual(result["docs/a.md"][0], "new")
        self.assertEqual(result["docs/b.md"][0], "old")

    def test_sensitive_examples_are_excluded_rather_than_published_as_clean(self):
        for text in ["person@example.com", "https://user:password@example.com/doc", "https://example.com?api_key=example_value", "-----BEGIN PRIVATE KEY-----"]:
            self.assertTrue(collector.sensitive(text))
        self.assertFalse(collector.sensitive("Set API_KEY=YOUR_API_KEY. A public document about typed tools."))

    def test_collection_excludes_contributors_and_non_document_files(self):
        self.assertFalse(collector.eligible("docs/contributors.md"))
        self.assertFalse(collector.eligible("src/runtime.py"))
        self.assertTrue(collector.eligible("docs/zh/guide.md"))


if __name__ == "__main__":
    unittest.main()

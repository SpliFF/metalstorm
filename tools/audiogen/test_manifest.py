#!/usr/bin/env python3
"""Unittest wrapper around validate.py's checks — pytest is broken in this
environment (bad interpreter shebang, see README.md TOOLING GAP note), so
this runs standalone: `python3 tools/audiogen/test_manifest.py`.
"""
import unittest
from pathlib import Path

import validate
from build import expand_entries, load_manifest


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = load_manifest()
        self.entries = expand_entries(self.manifest)

    def test_manifest_is_internally_consistent(self):
        self.assertEqual(validate.check_manifest(self.manifest), [])

    def test_every_synthesis_output_exists_on_disk(self):
        self.assertEqual(validate.check_files_exist(self.entries), [])

    def test_every_synthesis_entry_has_an_assets_md_row(self):
        self.assertEqual(validate.check_assets_md_rows(self.entries), [])

    def test_reserved_sonniss_rows_are_well_formed(self):
        for r in self.manifest["reserved_sonniss"]:
            self.assertIn("pack", r)
            self.assertIn("use", r)


class SoundsLuaTests(unittest.TestCase):
    def test_sounds_lua_loads_and_weapon_fx_resolves(self):
        lua_errors, keys = validate.check_sounds_lua_loads()
        self.assertEqual(lua_errors, [])
        self.assertGreater(len(keys), 0)
        fx_errors = validate.check_weapon_fx_resolves(keys)
        self.assertEqual(fx_errors, [])


if __name__ == "__main__":
    unittest.main()

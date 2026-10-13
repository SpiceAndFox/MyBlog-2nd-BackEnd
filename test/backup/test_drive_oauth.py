"""Offline checks for safe OAuth staging and probe boundaries."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

module_path = Path(os.environ.get("BACKUP_MODULE", Path(__file__).resolve().parents[2] / "scripts" / "auto-backup" / "backup.py"))
sys.path.insert(0, str(module_path.parent))
spec = importlib.util.spec_from_file_location("migrate_drive_oauth", module_path.with_name("migrate_drive_oauth.py"))
oauth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oauth)


class OAuthTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.live, self.candidate, self.client = (self.root / name for name in ("live.conf", "candidate.conf", "client.json"))
        self.original = "[GoogleDrive]\ntype = drive\nscope = drive\ntoken = old-private-token\n[Other]\ntype = local\n"
        self.live.write_text(self.original)
        self.client.write_text(json.dumps({"installed": {"client_id": "123456789-new.apps.googleusercontent.com", "client_secret": "fake-test-secret"}}))

    def test_prepare_preserves_live_and_other_remotes_but_drops_old_token(self):
        oauth.prepare(self.live, self.candidate, "GoogleDrive", self.client)
        self.assertEqual(self.live.read_text(), self.original)
        config = oauth.read_config(self.candidate)
        self.assertNotIn("token", config["GoogleDrive"])
        self.assertEqual(config["Other"]["type"], "local")
        self.assertEqual(self.candidate.stat().st_mode & 0o077, 0)

    def test_prepare_refuses_to_replace_candidate(self):
        self.candidate.write_text("keep authorized candidate")
        with self.assertRaises(oauth.BackupError):
            oauth.prepare(self.live, self.candidate, "GoogleDrive", self.client)
        self.assertEqual(self.candidate.read_text(), "keep authorized candidate")

    def test_shared_project_and_web_client_are_rejected(self):
        for client in ({"installed": {"client_id": "202264815644.apps.googleusercontent.com", "client_secret": "fake"}},
                       {"web": {"client_id": "123-new.apps.googleusercontent.com", "client_secret": "fake"}}):
            self.client.write_text(json.dumps(client))
            with self.assertRaises(oauth.BackupError):
                oauth.prepare(self.live, self.candidate, "GoogleDrive", self.client)
            self.assertFalse(self.candidate.exists())
            self.assertEqual(self.live.read_text(), self.original)

    def test_probe_wrong_account_fails_before_any_write(self):
        job = Mock()
        job.remote = "GoogleDrive:BlogBackup/automatic-v1"
        job.state = {"last_success": "known-backup"}
        job.rclone.return_value = b"[]"
        with self.assertRaises(oauth.BackupError):
            oauth.probe(job)
        job.rclone.assert_called_once_with("lsjson", job.remote, "--max-depth", "1")

    def test_probe_uses_unique_names_and_preserves_backups(self):
        job = Mock()
        job.remote, job.root, job.state = "GoogleDrive:BlogBackup/automatic-v1", self.root, {"last_success": "known-backup"}
        cloud = {job.remote + "/known-backup.dump.gpg": b"keep"}
        def rclone(op, source, *args):
            if op == "lsjson":
                return b'[{"Path":"known-backup.dump.gpg"}]'
            if op == "copyto":
                cloud[args[0]] = Path(source).read_bytes()
            elif op == "cat":
                return cloud[source]
            elif op == "moveto":
                cloud[args[0]] = cloud.pop(source)
            elif op == "deletefile":
                del cloud[source]
            else:
                raise AssertionError(op)
            return b""
        job.rclone.side_effect = rclone
        oauth.probe(job)
        self.assertEqual(cloud, {job.remote + "/known-backup.dump.gpg": b"keep"})


if __name__ == "__main__":
    unittest.main()

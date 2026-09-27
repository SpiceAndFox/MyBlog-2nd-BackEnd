"""Offline fault-injection tests; all databases and cloud operations are mocked."""
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

module_path = Path(os.environ.get("BACKUP_MODULE", Path(__file__).resolve().parents[2] / "scripts" / "auto-backup" / "backup.py"))
spec = importlib.util.spec_from_file_location("backup", module_path)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class FakeBackup(backup.Backup):
    cloud = None
    upload_failure = False
    corrupt_download = False
    rename_failure = False

    def rclone(self, *args):
        op, target = args[:2]
        if op == "copyto":
            if self.upload_failure:
                raise backup.BackupError("simulated upload failure")
            self.cloud[args[2]] = Path(target).read_bytes()
            return b""
        if op == "cat":
            if target not in self.cloud:
                raise backup.BackupError("not found")
            return self.cloud[target]
        if op == "moveto":
            if self.rename_failure:
                raise backup.BackupError("simulated rename failure")
            self.cloud[args[2]] = self.cloud.pop(target)
            return b""
        if op == "lsjson":
            prefix = target.rstrip("/") + "/"
            return json.dumps([{"Path": key[len(prefix):], "IsDir": False, "Size": len(self.cloud[key])}
                               for key in self.cloud if key.startswith(prefix)]).encode()
        if op == "deletefile":
            del self.cloud[target]
            return b""
        if op == "rmdir":
            assert not any(key.startswith(target + "/") for key in self.cloud)
            return b""
        raise AssertionError(args)

    def verify_remote_cipher(self, name, manifest, temporary=False):
        value = self.cloud[self.cloud_path(name, temporary)]
        if self.corrupt_download or hashlib.sha256(value).hexdigest() != manifest["cipher_sha256"]:
            raise backup.BackupError("simulated remote checksum mismatch")


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.config = {"backend_dir": str(self.directory), "local_dir": str(self.directory / "backups"),
                       "remote": "drive:BlogBackup/automatic-v1", "password_file": str(self.directory / "secrets.json"),
                       "rclone_config": str(self.directory / "rclone.conf"), "local_keep": 4, "remote_keep": 30}
        self.now = dt.datetime(2026, 1, 31, 12, tzinfo=dt.timezone.utc).timestamp()
        backup.atomic_json(self.config["password_file"], {"password": "unit-test-only-password"})
        self.cloud, self.dump_count, self.dump_error, self.empty_dump, self.encryption_error = {}, 0, False, False, False
        self.restore_error = False
        self.addCleanup(patch.stopall)
        patch.object(backup, "checked", side_effect=self.command).start()
        patch.object(backup, "postgres_environment", return_value={}).start()
        patch.object(backup, "log").start()

    def command(self, args, **_kwargs):
        op = args[0]
        if op == "pg_dump" and "--version" in args:
            return b"pg_dump (PostgreSQL) 17.7\n"
        if op == "pg_dump":
            self.dump_count += 1
            Path(args[args.index("--file") + 1]).write_bytes(b"" if self.empty_dump else b"PGDMP test data")
            if self.dump_error:
                raise backup.BackupError("database authentication failed")
        elif op == "pg_restore":
            self.assertTrue(Path(args[-1]).read_bytes().startswith(b"PGDMP"))
            if self.restore_error:
                raise backup.BackupError("archive is corrupt")
        elif op == "gpg":
            self.assertEqual(_kwargs["input"], b"unit-test-only-password\n")
            self.assertNotIn("unit-test-only-password", args)
            if self.encryption_error:
                raise backup.BackupError("encryption failed")
            Path(args[args.index("--output") + 1]).write_bytes(b"gpg-encrypted " + Path(args[-1]).read_bytes())
        elif op == "git":
            return b"1234567890abcdef\n"
        else:
            if op not in ("pg_dump", "pg_restore", "gpg"):
                raise AssertionError(args)
        return b""

    def job(self):
        job = FakeBackup(self.config, clock=lambda: self.now)
        job.cloud = self.cloud
        return job

    def test_success_is_verified_and_runs_again_after_72_hours_across_month_boundary(self):
        job = self.job()
        job.run()
        self.assertEqual(self.dump_count, 1)
        self.assertEqual(backup.stamp(job.state["next_due"]), "2026-02-03T12:00:00+00:00")
        self.assertFalse(job.state["retention_pending"])
        self.assertEqual(list(self.cloud), [job.cloud_path(job.state["last_success"])])
        self.now += backup.INTERVAL - 1
        self.job().run()
        self.assertEqual(self.dump_count, 1)
        self.now += 1
        self.job().run()
        self.assertEqual(self.dump_count, 2)

    def test_dump_failure_or_zero_bytes_never_publish_or_upload_a_backup(self):
        for empty in (False, True):
            with self.subTest(empty=empty):
                self.dump_error, self.empty_dump = not empty, empty
                job = self.job()
                with self.assertRaises(backup.BackupError):
                    job.run(force=True)
                self.assertFalse(job.local_names())
                self.assertFalse(list(job.root.glob(".partial-*")))
                self.assertEqual(self.cloud, {})
                self.assertNotIn("last_success", job.state)

    def test_encryption_failure_removes_temporary_plaintext(self):
        self.encryption_error = True
        job = self.job()
        with self.assertRaises(backup.BackupError):
            job.run()
        self.assertFalse(list(job.root.rglob("*.dump*")))
        self.assertFalse(self.cloud)

    def test_archive_validation_failure_prevents_upload_and_cleans_plaintext(self):
        self.restore_error = True
        job = self.job()
        with self.assertRaises(backup.BackupError):
            job.run()
        self.assertFalse(job.local_names())
        self.assertFalse(list(job.root.glob(".partial-*")))
        self.assertFalse(self.cloud)

    def test_failed_upload_is_retained_and_resumed_without_another_dump(self):
        job = self.job()
        job.upload_failure = True
        with self.assertRaises(backup.BackupError):
            job.run()
        pending = job.state["pending"]
        self.assertTrue((job.bundle(pending) / backup.CIPHER).is_file())
        self.assertFalse((job.bundle(pending) / "uploaded.json").exists())
        self.assertNotIn("last_success", job.state)
        self.job().run()
        self.assertEqual(self.dump_count, 1, "Backoff must avoid a second dump")
        self.now += 3600
        resumed = self.job()
        resumed.run()
        self.assertEqual(resumed.state["last_success"], pending)
        self.assertEqual(self.dump_count, 1)

    def test_remote_checksum_failure_cannot_publish_final_filename(self):
        job = self.job()
        job.corrupt_download = True
        with self.assertRaises(backup.BackupError):
            job.run()
        self.assertFalse(any(key.endswith("manifest.json") for key in self.cloud))
        self.assertNotIn("last_success", job.state)
        self.assertIsNotNone(job.state["pending"])
        self.assertNotIn(job.cloud_path(job.state["pending"]), self.cloud)
        self.assertIn(job.cloud_path(job.state["pending"], temporary=True), self.cloud)

    def test_failed_final_rename_is_retried_without_a_new_dump(self):
        job = self.job()
        job.rename_failure = True
        with self.assertRaises(backup.BackupError):
            job.run()
        name = job.state["pending"]
        self.assertNotIn(job.cloud_path(name), self.cloud)
        self.now += 3600
        self.job().run()
        self.assertEqual(self.dump_count, 1)
        self.assertEqual(list(self.cloud), [job.cloud_path(name)])

    def test_unrecorded_local_backup_is_resumed_after_crash(self):
        job = self.job()
        name = job.new_backup()
        job.state_path.unlink()
        resumed = self.job()
        resumed.run()
        self.assertEqual(self.dump_count, 1)
        self.assertEqual(resumed.state["last_success"], name)

    def test_retention_preserves_exact_counts_and_unmanaged_history(self):
        job = self.job()
        historical = job.root / "blog_20260924_001944.dump"
        historical.write_bytes(b"old recovery point")
        self.cloud["drive:BlogBackup/old.dump.age"] = b"old cloud recovery point"
        self.cloud[f"{job.remote}/blog_20260924_001944.dump.age"] = b"manual backup"
        self.cloud[f"{job.remote}/pgbackup-v1-not-a-backup.dump.gpg"] = b"unrelated file"
        self.cloud[f"{job.remote}/pgbackup-v1-20290131T120000Z-12345678.dump.gpg"] = b""
        self.cloud[f"{job.remote}/.pgbackup-v1-20290131T120000Z-12345678.dump.gpg.uploading"] = b"unfinished upload"
        self.cloud[f"{job.remote}/notes.txt"] = b"personal notes"
        protected_cloud = dict(self.cloud)
        foreign_id = "pgbackup-v1-20270131T120000Z-87654321"
        (job.root / foreign_id).mkdir()
        (job.root / foreign_id / "manifest.json").write_text('{"format":"unrelated"}')
        self.cloud[f"{job.remote}/{foreign_id}/manifest.json"] = b'{"format":"unrelated"}'
        for _ in range(35):
            self.job().run(force=True)
            self.now += backup.INTERVAL
        self.assertEqual(len(job.local_names()), 4)
        self.assertEqual(sum(bool(value) and key.startswith(job.remote + "/") and key.endswith(backup.CLOUD_SUFFIX)
                             and bool(backup.NAME.fullmatch(key[len(job.remote) + 1:-len(backup.CLOUD_SUFFIX)]))
                             for key, value in self.cloud.items()), 30)
        for key, value in protected_cloud.items():
            self.assertEqual(self.cloud[key], value)
        self.assertEqual(historical.read_bytes(), b"old recovery point")
        self.assertIn("drive:BlogBackup/old.dump.age", self.cloud)
        self.assertTrue((job.root / foreign_id / "manifest.json").is_file())
        self.assertIn(f"{job.remote}/{foreign_id}/manifest.json", self.cloud)

    def test_local_extra_files_and_unrelated_cloud_folders_are_preserved(self):
        self.config["local_keep"] = self.config["remote_keep"] = 1
        old = self.job()
        old.run()
        name = old.state["last_success"]
        (old.bundle(name) / "my-note.txt").write_text("keep")
        self.cloud[f"{old.remote}/{name}/my-note.txt"] = b"keep"
        self.now += backup.INTERVAL
        self.job().run()
        self.assertEqual((old.bundle(name) / "my-note.txt").read_text(), "keep")
        self.assertIn(f"{old.remote}/{name}/my-note.txt", self.cloud)
        self.assertNotIn(old.cloud_path(name), self.cloud)

    def test_unconfigured_password_fails_before_dumping(self):
        backup.atomic_json(self.config["password_file"], {"password": ""})
        with self.assertRaises(backup.BackupError):
            self.job().run()
        self.assertEqual(self.dump_count, 0)

    def test_readable_by_others_password_configuration_is_rejected(self):
        os.chmod(self.config["password_file"], 0o644)
        with self.assertRaises(backup.BackupError):
            self.job().run()
        self.assertEqual(self.dump_count, 0)

    def test_upload_failure_does_not_prune_existing_copies(self):
        self.config["local_keep"] = self.config["remote_keep"] = 1
        old = self.job()
        old.run()
        cloud_before = dict(self.cloud)
        self.now += backup.INTERVAL
        failed = self.job()
        failed.upload_failure = True
        with self.assertRaises(backup.BackupError):
            failed.run()
        self.assertEqual(self.cloud, cloud_before)
        self.assertEqual(len(failed.local_names()), 2, "Pending copy and successful copy must both survive")

    def test_local_symlink_cannot_escape_backup_root(self):
        job = self.job()
        name = "pgbackup-v1-20260131T120000Z-12345678"
        (job.root / name).symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(backup.BackupError):
            job.bundle(name)

    def test_remote_cleanup_failure_retains_success_and_retries_without_new_dump(self):
        job = self.job()
        with patch.object(job, "prune", side_effect=backup.BackupError("cleanup failed")):
            with self.assertRaises(backup.BackupError):
                job.run()
        self.assertIsNotNone(job.state["last_success"])
        self.assertTrue(job.state["retention_pending"])
        self.now += 3600
        self.job().run()
        self.assertEqual(self.dump_count, 1)

    def test_second_process_cannot_take_the_same_lock(self):
        job = self.job()
        with (job.root / ".lock").open("a") as first, (job.root / ".lock").open("a") as second:
            fcntl.flock(first, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                fcntl.flock(second, fcntl.LOCK_EX | fcntl.LOCK_NB)


if __name__ == "__main__":
    unittest.main()

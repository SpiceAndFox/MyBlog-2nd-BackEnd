#!/usr/bin/env python3
"""Verified PostgreSQL backups. No credentials are passed in command arguments."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import uuid
from urllib.parse import parse_qsl, unquote, urlsplit

FORMAT = "blog-postgres-backup-v1"
NAME = re.compile(r"pgbackup-v1-\d{8}T\d{6}Z-[0-9a-f]{8}\Z")
CIPHER = "database.dump.gpg"
CLOUD_SUFFIX = ".dump.gpg"
INTERVAL = 3 * 24 * 3600


class BackupError(RuntimeError):
    pass


def stamp(epoch=None):
    return dt.datetime.fromtimestamp(time.time() if epoch is None else epoch, dt.timezone.utc).isoformat()


def log(event, **fields):
    print(json.dumps({"at": stamp(), "event": event, **fields}, ensure_ascii=False), flush=True)


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf8") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf8"))


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def checked(command, **kwargs):
    result = subprocess.run(command, capture_output=True, timeout=1800, **kwargs)
    if result.returncode:
        # Do not echo credentials, environment variables, or entire command lines.
        detail = result.stderr.decode("utf8", errors="replace")[-1500:]
        detail = re.sub(r"postgres(?:ql)?://\S+", "postgresql://<redacted>", detail)
        raise BackupError(f"{Path(command[0]).name} exited {result.returncode}: {detail.strip()}")
    return result.stdout


def postgres_environment(backend):
    script = "require('dotenv').config({quiet:true}); process.stdout.write(process.env.DATABASE_URL || '')"
    url = checked(["node", "-e", script], cwd=backend).decode("utf8")
    if not url.startswith(("postgresql://", "postgres://")):
        raise BackupError("Application DATABASE_URL is missing or unsupported")
    parts = urlsplit(url)
    if not parts.hostname or not parts.username or not parts.path.strip("/"):
        raise BackupError("DATABASE_URL must identify a host, user and database")
    env = {**os.environ, "PGHOST": parts.hostname, "PGPORT": str(parts.port or 5432),
           "PGUSER": unquote(parts.username), "PGPASSWORD": unquote(parts.password or ""),
           "PGDATABASE": unquote(parts.path[1:]), "PGAPPNAME": "blog-verified-backup"}
    supported = {"sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT", "sslcert": "PGSSLCERT",
                 "sslkey": "PGSSLKEY", "options": "PGOPTIONS", "connect_timeout": "PGCONNECT_TIMEOUT",
                 "channel_binding": "PGCHANNELBINDING", "target_session_attrs": "PGTARGETSESSIONATTRS"}
    for name, value in parse_qsl(parts.query):
        if name not in supported:
            raise BackupError(f"Unsupported DATABASE_URL option: {name}")
        env[supported[name]] = value
    return env


def valid_manifest(value, name):
    return (isinstance(value, dict) and value.get("format") == FORMAT
            and value.get("id") == name and bool(NAME.fullmatch(name))
            and value.get("cipher_file") == CIPHER
            and isinstance(value.get("created_epoch"), (int, float))
            and isinstance(value.get("cipher_bytes"), int) and value["cipher_bytes"] > 0
            and bool(re.fullmatch(r"[0-9a-f]{64}", str(value.get("cipher_sha256", "")))))


class Backup:
    def __init__(self, config, clock=time.time):
        self.config, self.clock = config, clock
        self.root = Path(config["local_dir"]).resolve()
        self.backend = Path(config["backend_dir"]).resolve()
        self.remote = config["remote"].rstrip("/")
        if not re.fullmatch(r"[^:/\s]+:[^\r\n]+", self.remote) or self.remote.endswith(":"):
            raise BackupError("Use a dedicated rclone subdirectory, not the remote root")
        if not config.get("password_file"):
            raise BackupError("A password configuration file is required")
        for key in ("local_keep", "remote_keep"):
            if type(config[key]) is not int or config[key] < 1:
                raise BackupError(f"{key} must be a positive integer")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_path = self.root / "state.json"
        self.state = load_json(self.state_path) if self.state_path.exists() else {"version": 1, "remote": self.remote}
        if self.state.get("version") != 1 or self.state.get("remote") != self.remote:
            raise BackupError("State belongs to a different configuration")
        self.rclone_flags = ["--config", config["rclone_config"], "--contimeout", "30s", "--timeout", "5m",
                             "--retries", "3", "--low-level-retries", "3", "--retries-sleep", "10s", "--log-level", "ERROR"]

    def persist(self):
        atomic_json(self.state_path, self.state)

    def rclone(self, *args):
        return checked(["rclone", *args, *self.rclone_flags])

    def bundle(self, name):
        if not NAME.fullmatch(name):
            raise BackupError("Invalid backup identifier")
        folder = self.root / name
        if folder.is_symlink() or folder.resolve().parent != self.root:
            raise BackupError("Backup directory escapes its configured root")
        return folder

    def manifest(self, name):
        folder = self.bundle(name)
        file = folder / "manifest.json"
        if file.is_symlink():
            raise BackupError("Manifest cannot be a symlink")
        value = load_json(file)
        if not valid_manifest(value, name):
            raise BackupError(f"Invalid backup manifest: {name}")
        return value

    def local_names(self):
        names = []
        for entry in self.root.iterdir():
            if not NAME.fullmatch(entry.name) or not entry.is_dir() or entry.is_symlink():
                continue
            try:
                self.manifest(entry.name)
            except (OSError, ValueError, BackupError):
                continue
            names.append(entry.name)
        return sorted(names)

    def password(self):
        file = Path(self.config["password_file"])
        if not file.is_file() or file.is_symlink():
            raise BackupError("Password configuration is missing")
        if file.stat().st_mode & 0o077:
            raise BackupError("Password configuration must have mode 600")
        value = load_json(file).get("password")
        if not isinstance(value, str) or not value.strip() or any(char in value for char in "\r\n\0"):
            raise BackupError("Set a non-empty single-line password in backup-secrets.json")
        return value

    def new_backup(self):
        password = self.password()
        created = self.clock()
        name = "pgbackup-v1-" + dt.datetime.fromtimestamp(created, dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
        destination = self.bundle(name)
        log("dump_started", backup=name)
        # Failed dumps and plaintext live only in a private temporary directory;
        # an atomic rename publishes the backup only after both checks succeed.
        with tempfile.TemporaryDirectory(prefix=".partial-", dir=self.root) as temporary:
            stage = Path(temporary)
            plain = stage / "database.dump.partial"
            checked(["pg_dump", "--no-password", "--format=custom", "--file", str(plain)], env=postgres_environment(self.backend))
            if not plain.exists() or plain.stat().st_size == 0:
                raise BackupError("pg_dump produced an empty archive")
            checked(["pg_restore", "--file=/dev/null", str(plain)])
            archive_hash, archive_size = sha256(plain), plain.stat().st_size
            cipher = stage / CIPHER
            gpg_home = self.root / ".gnupg"
            gpg_home.mkdir(mode=0o700, exist_ok=True)
            checked(["gpg", "--no-options", "--homedir", str(gpg_home), "--batch", "--yes",
                     "--pinentry-mode", "loopback", "--no-symkey-cache", "--passphrase-fd", "0",
                     "--symmetric", "--cipher-algo", "AES256", "--s2k-mode", "3", "--s2k-digest-algo", "SHA256",
                     "--s2k-count", "65011712", "--output", str(cipher), str(plain)], input=(password + "\n").encode("utf8"))
            if not cipher.exists() or cipher.stat().st_size == 0:
                raise BackupError("gpg produced an empty encrypted archive")
            plain.unlink()
            manifest = {"format": FORMAT, "id": name, "created_at": stamp(created), "created_epoch": created,
                        "cipher_file": CIPHER, "cipher_bytes": cipher.stat().st_size, "cipher_sha256": sha256(cipher),
                        "archive_bytes": archive_size, "archive_sha256": archive_hash,
                        "encryption": {"method": "gpg-symmetric", "cipher": "AES256"},
                        "pg_dump_version": checked(["pg_dump", "--version"]).decode().strip(),
                        "backend_commit": checked(["git", "rev-parse", "HEAD"], cwd=self.backend).decode().strip()}
            atomic_json(stage / "manifest.json", manifest)
            os.rename(stage, destination)
        self.state["pending"] = name
        self.persist()
        log("archive_verified", backup=name, bytes=archive_size)
        return name

    def cloud_path(self, name, temporary=False):
        if not NAME.fullmatch(name):
            raise BackupError("Invalid backup identifier")
        filename = name + CLOUD_SUFFIX
        if temporary:
            filename = "." + filename + ".uploading"
        return f"{self.remote}/{filename}"

    def verify_remote_cipher(self, name, manifest, temporary=False):
        digest, size = hashlib.sha256(), 0
        with tempfile.TemporaryFile() as errors:
            with subprocess.Popen(["rclone", "cat", self.cloud_path(name, temporary), *self.rclone_flags],
                                  stdout=subprocess.PIPE, stderr=errors) as process:
                try:
                    for block in iter(lambda: process.stdout.read(1024 * 1024), b""):
                        digest.update(block)
                        size += len(block)
                    code = process.wait(timeout=1800)
                except BaseException:
                    process.kill()
                    process.wait()
                    raise
            if code:
                errors.seek(0)
                detail = errors.read().decode("utf8", errors="replace")[-1500:].strip()
                raise BackupError(f"Remote verification download failed (exit {code}): {detail}")
        if size != manifest["cipher_bytes"] or digest.hexdigest() != manifest["cipher_sha256"]:
            raise BackupError("Remote encrypted archive failed size/SHA-256 verification")

    def upload(self, name):
        folder = self.bundle(name)
        manifest = self.manifest(name)
        cipher = folder / CIPHER
        if cipher.is_symlink() or not cipher.is_file() or sha256(cipher) != manifest["cipher_sha256"]:
            raise BackupError("Local encrypted archive failed integrity verification")
        # Only a verified upload receives a filename eligible for retention.
        # The local manifest remains local; each cloud backup is one file.
        self.rclone("copyto", str(cipher), self.cloud_path(name, temporary=True), "--checksum")
        self.verify_remote_cipher(name, manifest, temporary=True)
        self.rclone("moveto", self.cloud_path(name, temporary=True), self.cloud_path(name))
        atomic_json(folder / "uploaded.json", {"remote": self.remote, "verified_at": stamp(self.clock())})
        self.state.update(pending=None, last_success=name, last_success_at=stamp(self.clock()),
                          next_due=manifest["created_epoch"] + INTERVAL, retry_not_before=0,
                          last_error=None, retention_pending=True)
        self.persist()
        log("cloud_verified", backup=name, next_due=stamp(self.state["next_due"]))

    def prune(self):
        rows = json.loads(self.rclone("lsjson", self.remote, "--files-only", "--max-depth", "1"))
        names = set()
        for row in rows:
            filename = row.get("Path", "")
            if not row.get("IsDir") and row.get("Size", 0) > 0 and filename.endswith(CLOUD_SUFFIX):
                name = filename[:-len(CLOUD_SUFFIX)]
                if NAME.fullmatch(name):
                    names.add(name)
        for name in sorted(names, reverse=True)[self.config["remote_keep"]:]:
            if name == self.state.get("last_success"):
                continue
            # Never traverse or purge other folders, or match arbitrary blog_* files.
            self.rclone("deletefile", self.cloud_path(name))
            log("remote_retired", backup=name)
        uploaded = []
        for name in self.local_names():
            self.manifest(name)
            receipt = self.bundle(name) / "uploaded.json"
            if receipt.exists() and not receipt.is_symlink() and load_json(receipt).get("remote") == self.remote:
                uploaded.append(name)
        for name in sorted(uploaded, reverse=True)[self.config["local_keep"]:]:
            if name in (self.state.get("pending"), self.state.get("last_success")):
                continue
            folder = self.bundle(name)
            files = list(folder.iterdir())
            if {entry.name for entry in files} != {CIPHER, "manifest.json", "uploaded.json"} or any(entry.is_symlink() or not entry.is_file() for entry in files):
                log("local_retention_skipped", backup=name, reason="unmanaged files present")
                continue
            for entry in files:
                entry.unlink()
            folder.rmdir()
            log("local_retired", backup=name)
        self.state["retention_pending"] = False
        self.persist()

    def run(self, force=False):
        now = self.clock()
        if not force and now < self.state.get("retry_not_before", 0):
            return
        try:
            pending = self.state.get("pending")
            if not pending:
                # Recover the small crash window between publishing a local
                # encrypted archive and recording its pending upload in state.
                pending = next((name for name in self.local_names() if not (self.bundle(name) / "uploaded.json").exists()), None)
            if pending:
                self.state["pending"] = pending
                self.persist()
                self.upload(pending)
            elif force or now >= self.state.get("next_due", 0):
                self.upload(self.new_backup())
            if self.state.get("retention_pending"):
                self.prune()
            self.state.update(last_error=None, retry_not_before=0)
            # No writes or network calls are necessary on an ordinary not-due tick.
            if self.state_path.exists() and load_json(self.state_path) != self.state:
                self.persist()
        except Exception as error:
            self.state.update(last_error=str(error), last_failure_at=stamp(now), retry_not_before=self.clock() + 3600)
            self.persist()
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--force", action="store_true", help="Run now; an unfinished upload is resumed first")
    parser.add_argument("--status", action="store_true", help="Print local state without uploading or dumping")
    args = parser.parse_args()
    os.umask(0o077)
    config = load_json(args.config)
    root = Path(config["local_dir"])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / ".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("already_running")
            return
        job = Backup(config)
        if args.status:
            value = {**job.state, "local_dir": str(job.root), "local_keep": config["local_keep"], "remote_keep": config["remote_keep"]}
            if value.get("next_due"):
                value["next_due_utc"] = stamp(value["next_due"])
            print(json.dumps(value, indent=2))
            return
        job.run(force=args.force)


def interrupted(*_):
    raise KeyboardInterrupt()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        log("backup_failed", reason=str(error) or "interrupted")
        raise SystemExit(1)

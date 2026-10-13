#!/usr/bin/env python3
"""Stage a private Drive OAuth configuration, then verify it before activation."""
import argparse
import configparser
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import uuid

from backup import Backup, BackupError, CLOUD_SUFFIX, atomic_json, load_json


def read_config(path):
    config = configparser.ConfigParser(interpolation=None)
    with Path(path).open(encoding="utf8") as stream:
        config.read_file(stream)
    return config


def private_write(path, value):
    path = Path(path)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf8", dir=path.parent,
                                     prefix=".oauth-", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            os.chmod(temporary, 0o600)
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def validate_drive(config, section, require_token=False):
    if section not in config or config[section].get("type") != "drive":
        raise BackupError("The selected remote must be a Google Drive remote")
    remote = config[section]
    client_id = remote.get("client_id", "")
    if not client_id.endswith(".apps.googleusercontent.com") or client_id.startswith(("202264815644.", "202264815644-")):
        raise BackupError("Use an OAuth client from your own Google Cloud project")
    if not remote.get("client_secret") or remote.get("scope", "drive") != "drive":
        raise BackupError("A client secret and the existing full drive scope are required")
    if remote.get("service_account_file") or remote.get("service_account_credentials"):
        raise BackupError("This migration is for user OAuth, not service accounts")
    if require_token and not json.loads(remote.get("token", "{}")).get("refresh_token"):
        raise BackupError("Authorize the candidate configuration first")


def prepare(live, candidate, section, client_json):
    if candidate.exists():
        raise BackupError("Candidate already exists; refusing to overwrite an authorization")
    source = load_json(client_json)
    client = source.get("installed", {})
    config = read_config(live)
    if section not in config or config[section].get("type") != "drive":
        raise BackupError("The existing remote must be Google Drive")
    config[section]["client_id"] = client.get("client_id", "")
    config[section]["client_secret"] = client.get("client_secret", "")
    config[section].pop("token", None)
    validate_drive(config, section)
    output = io.StringIO()
    config.write(output)
    private_write(candidate, output.getvalue())
    print("Candidate prepared without the old token; authorize it with rclone config reconnect.")


def probe(job):
    # Read the existing backup directory first; do not create a replacement tree
    # if the user authorized a different account or cannot see existing backups.
    rows = json.loads(job.rclone("lsjson", job.remote, "--max-depth", "1"))
    expected = job.state.get("last_success")
    if expected and not any(row.get("Path") == expected + CLOUD_SUFFIX for row in rows):
        raise BackupError("The candidate cannot see the last successful backup; check account and folder")
    prefix = f"{job.remote}/.oauth-check-{uuid.uuid4().hex}"
    temporary, final = prefix + ".uploading", prefix + ".verified"
    with tempfile.TemporaryDirectory(prefix=".oauth-check-", dir=job.root) as directory:
        file = Path(directory) / "probe.bin"
        value = os.urandom(4096)
        file.write_bytes(value)
        try:
            job.rclone("copyto", str(file), temporary)
            downloaded = job.rclone("cat", temporary)
            if hashlib.sha256(downloaded).digest() != hashlib.sha256(value).digest():
                raise BackupError("OAuth probe download failed SHA-256 verification")
            job.rclone("moveto", temporary, final)
            if job.rclone("cat", final) != value:
                raise BackupError("OAuth probe could not be read after rename")
            job.rclone("deletefile", final)
        except Exception:
            # Keep uniquely named probes for investigation on failure; never
            # delete or overwrite backups while testing a new configuration.
            print("Probe failed; any test files use only the .oauth-check- prefix.")
            raise
    print("Candidate passed directory listing, upload, download/hash, rename and cleanup.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "check", "activate"))
    parser.add_argument("--config", required=True, help="Existing backup.conf.json")
    parser.add_argument("--candidate", required=True, help="Private candidate rclone.conf")
    parser.add_argument("--client-json", help="Downloaded Desktop OAuth client JSON")
    args = parser.parse_args()
    os.umask(0o077)
    config = load_json(args.config)
    live, candidate = Path(config["rclone_config"]).resolve(), Path(args.candidate).resolve()
    if live == candidate:
        raise BackupError("Candidate must be separate from the live rclone configuration")
    section = config["remote"].split(":", 1)[0]
    if args.action == "prepare":
        if not args.client_json:
            parser.error("prepare requires --client-json")
        prepare(live, candidate, section, args.client_json)
        return
    if candidate.stat().st_mode & 0o077:
        raise BackupError("Candidate configuration must have mode 600")
    validate_drive(read_config(candidate), section, require_token=True)
    job = Backup({**config, "rclone_config": str(candidate)})
    # Use the same lock as the timer during probing and the atomic switch.
    with (job.root / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        probe(job)
        if args.action == "activate":
            snapshot = live.with_name(live.name + ".before-oauth-" + uuid.uuid4().hex)
            private_write(snapshot, live.read_text(encoding="utf8"))
            private_write(live, candidate.read_text(encoding="utf8"))
            job.state["retry_not_before"] = 0
            atomic_json(job.state_path, job.state)
            print("Verified configuration activated; cloud retry backoff reset. Previous configuration saved privately.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # ConfigParser exceptions can contain a raw source line with a secret.
        print("OAuth migration failed (" + type(error).__name__ + "); configuration not confirmed active.")
        raise SystemExit(1)

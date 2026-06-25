#!/usr/bin/env bash
# 
# Usage：
# cd BlogBackEnd
# chmod +x extensions/install-pgvector-debian.sh
# ./extensions/install-pgvector-debian.sh --pg-major 17 --enable-database

set -euo pipefail

PGVECTOR_VERSION="${PGVECTOR_VERSION:-v0.8.3}"
PG_MAJOR="${PG_MAJOR:-}"
DATABASE_URL="${DATABASE_URL:-}"
ENV_FILE="${ENV_FILE:-}"
ENABLE_DATABASE="${ENABLE_DATABASE:-0}"
BUILD_FROM_SOURCE="${BUILD_FROM_SOURCE:-0}"

usage() {
  cat <<'USAGE'
Usage:
  ./install-pgvector-debian.sh [--pg-major 17] [--enable-database] [--env-file ../.env] [--build-from-source]

Environment overrides:
  PGVECTOR_VERSION=v0.8.3
  PG_MAJOR=17
  DATABASE_URL=postgres://...
  ENABLE_DATABASE=1
  BUILD_FROM_SOURCE=1

Notes:
  - Uses the PostgreSQL APT package postgresql-<major>-pgvector by default.
  - If the package is unavailable, pass --build-from-source.
  - Does not store database credentials; it only reads DATABASE_URL for CREATE EXTENSION.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pg-major)
      PG_MAJOR="${2:-}"
      shift 2
      ;;
    --enable-database)
      ENABLE_DATABASE=1
      shift
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --database-url)
      DATABASE_URL="${2:-}"
      shift 2
      ;;
    --build-from-source)
      BUILD_FROM_SOURCE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend_dir="$(cd "$script_dir/.." && pwd)"
if [[ -z "$ENV_FILE" ]]; then
  ENV_FILE="$backend_dir/.env"
fi

read_env_value() {
  local name="$1"
  local path="$2"
  if [[ ! -f "$path" ]]; then
    return 0
  fi
  awk -F= -v key="$name" '
    /^[[:space:]]*#/ { next }
    NF >= 2 {
      k=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", k)
      if (k == key) {
        sub(/^[^=]*=/, "")
        gsub(/^[[:space:]]+|[[:space:]]+$/, "")
        print
        exit
      }
    }
  ' "$path"
}

if [[ -z "$PG_MAJOR" ]]; then
  if command -v pg_config >/dev/null 2>&1; then
    PG_MAJOR="$(pg_config --version | awk '{print $2}' | cut -d. -f1)"
  elif command -v psql >/dev/null 2>&1; then
    PG_MAJOR="$(psql --version | awk '{print $3}' | cut -d. -f1)"
  fi
fi

if [[ -z "$PG_MAJOR" ]]; then
  echo "Could not determine PostgreSQL major version. Pass --pg-major." >&2
  exit 1
fi

echo "PostgreSQL major version: $PG_MAJOR"

if [[ "$BUILD_FROM_SOURCE" == "1" ]]; then
  sudo apt-get update
  sudo apt-get install -y "postgresql-server-dev-$PG_MAJOR" build-essential git ca-certificates

  work_dir="$(mktemp -d)"
  trap 'rm -rf "$work_dir"' EXIT
  git clone --branch "$PGVECTOR_VERSION" --depth 1 https://github.com/pgvector/pgvector.git "$work_dir/pgvector"
  make -C "$work_dir/pgvector"
  sudo make -C "$work_dir/pgvector" install
else
  sudo apt-get update
  if ! sudo apt-get install -y "postgresql-$PG_MAJOR-pgvector"; then
    echo "APT package postgresql-$PG_MAJOR-pgvector was unavailable." >&2
    echo "Install the PostgreSQL APT repository or rerun with --build-from-source." >&2
    exit 1
  fi
fi

if ! sudo -u postgres psql -d template1 -tAc "SELECT default_version FROM pg_available_extensions WHERE name = 'vector';" | grep -q .; then
  echo "pgvector was not found in pg_available_extensions after installation." >&2
  exit 1
fi

echo "pgvector is available to PostgreSQL."

if [[ "$ENABLE_DATABASE" == "1" ]]; then
  if [[ -z "$DATABASE_URL" ]]; then
    DATABASE_URL="$(read_env_value DATABASE_URL "$ENV_FILE")"
  fi
  if [[ -z "$DATABASE_URL" ]]; then
    echo "DATABASE_URL is required to enable pgvector. Pass --database-url or set it in $ENV_FILE." >&2
    exit 1
  fi

  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector;"
  echo "pgvector extension enabled in target database."
fi


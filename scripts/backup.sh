#!/usr/bin/env bash
set -euo pipefail

# ===== 配置区 =====
DB_NAME="blog"
DB_USER="spice"
REMOTE="GoogleDrive:BlogBackup"
KEEP_PLAIN_DUMP=false   # true 保留明文 dump，false 会删除明文 dump

# ===== 生成文件名（带时间戳）=====
TS="$(date +%Y%m%d_%H%M%S)"
DUMP_FILE="${DB_NAME}_${TS}.dump"
ENC_FILE="${DUMP_FILE}.age"

echo "==> [1/3] Dumping database: ${DB_NAME} -> ${DUMP_FILE}"
pg_dump -U "${DB_USER}" -F c "${DB_NAME}" -f "${DUMP_FILE}"

echo "==> [2/3] Encrypting dump with age (password mode): ${ENC_FILE}"
age -p -o "${ENC_FILE}" "${DUMP_FILE}"

if [ "${KEEP_PLAIN_DUMP}" = false ]; then
  echo "==> Removing plain dump file: ${DUMP_FILE}"
  rm -f "${DUMP_FILE}"
fi

echo "==> [3/3] Uploading encrypted file to rclone remote: ${REMOTE}/"
rclone copy "./${ENC_FILE}" "${REMOTE}/"

echo "✅ Backup finished: ${ENC_FILE} uploaded to ${REMOTE}/"
rm -f "${ENC_FILE}"


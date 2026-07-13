const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { Pool } = require("pg");
require("dotenv").config({ quiet: true });

function readResolvNameserver() {
  try {
    const match = fs.readFileSync("/etc/resolv.conf", "utf8").match(/^nameserver\s+([^\s#]+)/m);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function readDefaultGateway() {
  try {
    const lines = fs.readFileSync("/proc/net/route", "utf8").trim().split(/\r?\n/).slice(1);
    const row = lines.map((line) => line.trim().split(/\s+/)).find((fields) => fields[1] === "00000000");
    if (!row?.[2] || !/^[0-9A-Fa-f]{8}$/.test(row[2])) return null;
    const bytes = row[2].match(/../g).reverse().map((part) => Number.parseInt(part, 16));
    return bytes.join(".");
  } catch {
    return null;
  }
}

function isLoopback(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(hostname || "").toLowerCase());
}

function candidateUrls() {
  const configured = String(process.env.WINDOWS_DATABASE_URL || process.env.DATABASE_URL || "").trim();
  if (!configured) throw new Error("DATABASE_URL or WINDOWS_DATABASE_URL is required");
  const base = new URL(configured);
  const candidates = [base];
  const isWsl = Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME);
  if (isWsl && isLoopback(base.hostname)) {
    const hosts = [process.env.WINDOWS_DATABASE_HOST, readResolvNameserver(), readDefaultGateway()]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    for (const host of [...new Set(hosts)]) {
      const candidate = new URL(base);
      candidate.hostname = host;
      candidates.push(candidate);
    }
  }
  return candidates;
}

function safeTarget(url) {
  return `${url.hostname}:${url.port || "5432"}`;
}

async function inspect(url) {
  const pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000 });
  try {
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('chat_preset_memory','chat_preset_memory_checkpoints')
      ORDER BY table_name
    `);
    const columns = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'chat_preset_memory'
      ORDER BY ordinal_position
    `);
    const oldColumnNames = new Set([
      "rolling_summary", "rolling_summary_updated_at", "summarized_until_message_id",
      "dirty_since_message_id", "rebuild_required", "core_memory",
    ]);
    const legacyColumns = columns.rows.map((row) => row.column_name).filter((name) => oldColumnNames.has(name));
    const legacyCheckpointTable = tables.rows.some((row) => row.table_name === "chat_preset_memory_checkpoints");
    return {
      target: safeTarget(url),
      clean: !legacyCheckpointTable && legacyColumns.length === 0,
      tables: tables.rows.map((row) => row.table_name),
      memoryColumns: columns.rows,
      legacy: { checkpointTable: legacyCheckpointTable, columns: legacyColumns },
    };
  } finally {
    await pool.end();
  }
}

function findWindowsPsql() {
  const command = '$cmd = Get-Command psql.exe -ErrorAction SilentlyContinue; if ($cmd) { $cmd.Source } else { Get-ChildItem "C:\\Program Files\\PostgreSQL" -Filter psql.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }';
  const found = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", timeout: 10000 });
  const windowsPath = String(found.stdout || "").trim();
  if (!windowsPath) return null;
  const converted = spawnSync("wslpath", ["-u", windowsPath], { encoding: "utf8", timeout: 3000 });
  return converted.status === 0 ? String(converted.stdout || "").trim() : null;
}

function inspectThroughWindowsPsql(url) {
  const psql = findWindowsPsql();
  if (!psql) throw new Error("Windows psql.exe was not found");
  const host = isLoopback(url.hostname) ? "127.0.0.1" : url.hostname;
  const port = url.port || "5432";
  const sql = `
    SELECT json_build_object(
      'tables', COALESCE((SELECT json_agg(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('chat_preset_memory','chat_preset_memory_checkpoints')), '[]'::json),
      'memoryColumns', COALESCE((SELECT json_agg(json_build_object('column_name',column_name,'data_type',data_type) ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='chat_preset_memory'), '[]'::json),
      'legacyCheckpointTable', EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='chat_preset_memory_checkpoints'),
      'legacyColumns', COALESCE((SELECT json_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='chat_preset_memory' AND column_name IN ('rolling_summary','rolling_summary_updated_at','summarized_until_message_id','dirty_since_message_id','rebuild_required','core_memory')), '[]'::json)
    )::text;
  `;
  const result = spawnSync(psql, [
    "-X", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1",
    "-h", host, "-p", port,
    "-U", decodeURIComponent(url.username), "-d", decodeURIComponent(url.pathname.replace(/^\//, "")),
    "-c", sql,
  ], {
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      PGPASSWORD: decodeURIComponent(url.password),
      WSLENV: [process.env.WSLENV, "PGPASSWORD"].filter(Boolean).join(":"),
    },
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.error?.message || "Windows psql failed").trim());
  const parsed = JSON.parse(String(result.stdout || "").trim());
  return {
    target: `${host}:${port} (Windows psql.exe)`,
    clean: !parsed.legacyCheckpointTable && parsed.legacyColumns.length === 0,
    tables: parsed.tables,
    memoryColumns: parsed.memoryColumns,
    legacy: { checkpointTable: parsed.legacyCheckpointTable, columns: parsed.legacyColumns },
  };
}

async function main() {
  const urls = candidateUrls();
  const failures = [];
  for (const url of urls) {
    try {
      const result = await inspect(url);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.clean) process.exitCode = 2;
      return;
    } catch (error) {
      failures.push({ target: safeTarget(url), code: error.code || null, message: error.message });
    }
  }
  if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) {
    try {
      const result = inspectThroughWindowsPsql(urls[0]);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.clean) process.exitCode = 2;
      return;
    } catch (error) {
      failures.push({ target: "windows-localhost:5432 (psql.exe)", code: error.code || null, message: error.message });
    }
  }
  const error = new Error("Unable to connect to PostgreSQL from WSL");
  error.failures = failures;
  throw error;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  for (const failure of error.failures || []) {
    process.stderr.write(`- ${failure.target}: ${failure.code || "ERROR"} ${failure.message}\n`);
  }
  process.stderr.write("Set WINDOWS_DATABASE_HOST to the Windows host IP, and ensure PostgreSQL listen_addresses/pg_hba.conf and Windows Firewall allow the WSL subnet.\n");
  process.exitCode = 1;
});

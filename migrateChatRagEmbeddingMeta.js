#!/usr/bin/env node
// pnpm migrate-chat-rag-embedding-meta -- --apply
const { createCommandContext } = require("./app/composition/commandContext");
const { database: db, config: { chatRagConfig } } = createCommandContext();

const DEFAULT_OLD_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw || !raw.startsWith("--")) continue;
    const key = raw.slice(2).trim();
    if (!key) continue;

    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith("--")) {
      parsed[key] = next;
      index += 1;
      continue;
    }

    parsed[key] = true;
  }
  return parsed;
}

function parsePositiveInt(value, { name } = {}) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid ${name || "integer"}: ${String(value)}`);
  }
  return number;
}

function optionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveStringArg(args, names, fallback) {
  for (const name of names) {
    const value = optionalString(args[name]);
    if (value) return value;
  }
  return fallback;
}

function resolvePositiveIntArg(args, names, fallback, { label } = {}) {
  for (const name of names) {
    if (args[name] === undefined) continue;
    return parsePositiveInt(args[name], { name: label || name });
  }
  return fallback;
}

function addOptionalScopeFilter({ clauses, params, column, value }) {
  if (value === undefined || value === null || value === "") return;
  params.push(value);
  clauses.push(`${column} = $${params.length}`);
}

function buildWhereClause({ source, scope } = {}) {
  const clauses = [];
  const params = [];

  params.push(source.provider);
  clauses.push(`embedding_provider = $${params.length}`);
  params.push(source.model);
  clauses.push(`embedding_model = $${params.length}`);
  params.push(source.dimensions);
  clauses.push(`embedding_dimensions = $${params.length}`);

  addOptionalScopeFilter({ clauses, params, column: "user_id", value: scope.userId });
  addOptionalScopeFilter({ clauses, params, column: "preset_id", value: scope.presetId });
  addOptionalScopeFilter({ clauses, params, column: "session_id", value: scope.sessionId });

  return { where: clauses.join(" AND "), params };
}

function sameMeta(left, right) {
  return left.provider === right.provider && left.model === right.model && left.dimensions === right.dimensions;
}

function printUsage() {
  console.log(
    `
Usage:
  pnpm migrate-chat-rag-embedding-meta -- [--apply] [options]
  node migrateChatRagEmbeddingMeta.js [--apply] [options]

Options:
  --from-provider <provider>      Default: openai-compatible
  --from-model <model>            Default: qwen/qwen3-embedding-8b
  --from-dimensions <n>           Default: current CHAT_RAG_EMBEDDING_DIMENSIONS
  --to-provider <provider>        Default: current CHAT_RAG_EMBEDDING_PROVIDER
  --to-model <model>              Default: current CHAT_RAG_EMBEDDING_MODEL
  --to-dimensions <n>             Default: current CHAT_RAG_EMBEDDING_DIMENSIONS
  --user <id>                     Optional scope filter
  --preset <presetId>             Optional scope filter
  --session <id>                  Optional scope filter
  --apply                         Write changes. Without this, only prints a dry-run plan.
  --allow-dimension-meta-change   Permit changing embedding_dimensions metadata without rewriting vectors.

Examples:
  pnpm migrate-chat-rag-embedding-meta --
  pnpm migrate-chat-rag-embedding-meta -- --apply
  pnpm migrate-chat-rag-embedding-meta -- --user 1 --preset default --apply
`.trim(),
  );
}

async function countRows(client, { source, scope }) {
  const { where, params } = buildWhereClause({ source, scope });
  const result = await client.query(`SELECT COUNT(*)::int AS count FROM chat_rag_chunks WHERE ${where}`, params);
  return Number(result.rows[0]?.count) || 0;
}

async function countTargetRows(client, { target, scope }) {
  const source = target;
  return countRows(client, { source, scope });
}

async function updateRows(client, { source, target, scope }) {
  const { where, params } = buildWhereClause({ source, scope });
  const updateParams = [...params, target.provider, target.model, target.dimensions];
  const providerParam = params.length + 1;
  const modelParam = params.length + 2;
  const dimensionsParam = params.length + 3;

  const result = await client.query(
    `
      WITH updated AS (
        UPDATE chat_rag_chunks
        SET embedding_provider = $${providerParam},
            embedding_model = $${modelParam},
            embedding_dimensions = $${dimensionsParam}
        WHERE ${where}
        RETURNING 1
      )
      SELECT COUNT(*)::int AS count FROM updated
    `,
    updateParams,
  );
  return Number(result.rows[0]?.count) || 0;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printUsage();
    return;
  }

  if (!chatRagConfig.enabled) {
    throw new Error("CHAT_RAG_ENABLED must be true before migrating chat RAG chunk metadata");
  }

  const source = {
    provider: resolveStringArg(args, ["from-provider", "fromProvider"], "openai-compatible"),
    model: resolveStringArg(args, ["from-model", "fromModel"], DEFAULT_OLD_EMBEDDING_MODEL),
    dimensions: resolvePositiveIntArg(args, ["from-dimensions", "fromDimensions"], chatRagConfig.embeddingDimensions, {
      label: "from-dimensions",
    }),
  };

  const target = {
    provider: resolveStringArg(args, ["to-provider", "toProvider"], chatRagConfig.embeddingProvider),
    model: resolveStringArg(args, ["to-model", "toModel"], chatRagConfig.embeddingModel),
    dimensions: resolvePositiveIntArg(args, ["to-dimensions", "toDimensions"], chatRagConfig.embeddingDimensions, {
      label: "to-dimensions",
    }),
  };

  const scope = {
    userId:
      args.user === undefined && args.userId === undefined
        ? undefined
        : parsePositiveInt(args.user ?? args.userId, { name: "user" }),
    presetId: resolveStringArg(args, ["preset", "presetId"], ""),
    sessionId:
      args.session === undefined && args.sessionId === undefined
        ? undefined
        : parsePositiveInt(args.session ?? args.sessionId, { name: "session" }),
  };

  const apply = Boolean(args.apply);
  const allowDimensionMetaChange = Boolean(args["allow-dimension-meta-change"] || args.allowDimensionMetaChange);

  if (sameMeta(source, target)) {
    throw new Error("Source and target embedding metadata are identical; nothing to migrate");
  }

  if (source.dimensions !== target.dimensions && !allowDimensionMetaChange) {
    throw new Error(
      "Refusing to change embedding_dimensions metadata without rewriting vectors. " +
        "Pass --allow-dimension-meta-change only if you have verified the stored vectors match the target dimensions.",
    );
  }

  const client = await db.getClient();
  try {
    const sourceCount = await countRows(client, { source, scope });
    const targetCount = await countTargetRows(client, { target, scope });

    const plan = {
      mode: apply ? "apply" : "dry-run",
      source,
      target,
      scope: {
        userId: scope.userId || null,
        presetId: scope.presetId || null,
        sessionId: scope.sessionId || null,
      },
      currentEmbeddingBaseUrl: chatRagConfig.embeddingBaseUrl,
      matchingSourceRows: sourceCount,
      existingTargetRows: targetCount,
    };

    console.log("chat RAG embedding metadata migration plan:");
    console.log(JSON.stringify(plan, null, 2));

    if (!apply) {
      console.log("dry-run only; rerun with --apply to update rows.");
      return;
    }

    await client.query("BEGIN");
    const updated = await updateRows(client, { source, target, scope });
    await client.query("COMMIT");
    console.log(`updated rows: ${updated}`);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures so the original error stays visible.
    }
    throw error;
  } finally {
    client.release();
    await db.end();
  }
})().catch(async (error) => {
  console.error(error?.stack || String(error));
  try {
    await db.end();
  } catch {
    // ignore
  }
  process.exit(1);
});

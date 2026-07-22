function isUnknownCommitOutcome(error) {
  return error?.connectionLost === true || [
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "57P01",
    "57P02",
    "57P03",
    "08000",
    "08003",
    "08006",
    "08007",
    "08P01",
  ].includes(error?.code);
}

function createTransactionExecutor({ database } = {}) {
  if (typeof database?.getClient !== "function") {
    throw new Error("Transaction executor requires a database with getClient");
  }

  async function run(work) {
    if (typeof work !== "function") throw new Error("Transaction work is required");
    const client = await database.getClient();
    let committing = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      committing = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (committing && isUnknownCommitOutcome(error)) error.commitOutcomeUnknown = true;
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ run });
}

module.exports = { createTransactionExecutor };

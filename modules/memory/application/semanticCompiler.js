const {
  SemanticCompileError,
  compileSemanticResult: compilePureSemanticResult,
  compiledProposalSourceRequest,
  revalidateCompiledProposal: revalidatePureCompiledProposal,
  semanticSourceRequest,
} = require("../domain/semanticCompiler");

async function readSourceMessages(sourceReader, userId, presetId, ids, client) {
  if (!ids.length) return [];
  if (!sourceReader?.getByIds) {
    throw new SemanticCompileError("compile_invariant_failed", { reason: "source_reader_missing" });
  }
  try {
    return await sourceReader.getByIds(userId, presetId, ids, { client });
  } catch (error) {
    throw new SemanticCompileError("source_validation_failed", {
      reason: "source_query_failed",
      code: error?.code || null,
    });
  }
}

async function compileSemanticResult({ artifact, semanticResult, baseState, sourceReader, userId, presetId, client } = {}) {
  const request = semanticSourceRequest({ artifact, semanticResult, baseState });
  const sourceMessages = await readSourceMessages(sourceReader, userId, presetId, request.ids, client);
  return compilePureSemanticResult({ artifact, semanticResult, baseState, sourceMessages, userId, presetId });
}

async function revalidateCompiledProposal({ proposal, task, baseState, sourceReader, userId, presetId, client } = {}) {
  const request = compiledProposalSourceRequest({ proposal, task, baseState });
  const sourceMessages = await readSourceMessages(sourceReader, userId, presetId, request.ids, client);
  return revalidatePureCompiledProposal({ proposal, task, baseState, sourceMessages, userId, presetId });
}

function createSemanticCompiler({ sourceReader } = {}) {
  if (!sourceReader?.getByIds) throw new Error("Semantic Compiler requires a Chat source reader");
  return Object.freeze({
    compile(input) { return compileSemanticResult({ ...input, sourceReader }); },
    revalidate(input) { return revalidateCompiledProposal({ ...input, sourceReader }); },
  });
}

module.exports = {
  SemanticCompileError,
  compileSemanticResult,
  createSemanticCompiler,
  revalidateCompiledProposal,
};

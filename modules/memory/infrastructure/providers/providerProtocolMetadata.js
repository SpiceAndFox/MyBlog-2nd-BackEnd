const { createHash } = require("node:crypto");
const { outputProtocolForProposer } = require("../../contracts/outputProtocol");

function providerProtocolMetadata(task, responseSchema) {
  return {
    outputProtocol: outputProtocolForProposer(task?.proposer),
    schemaHash: createHash("sha256").update(JSON.stringify(responseSchema)).digest("hex"),
    schemaBytes: Buffer.byteLength(JSON.stringify(responseSchema.schema)),
  };
}

function providerWireSchemaMetadata(body) {
  const schema = body.tools?.[0]?.function?.parameters ?? body.response_format?.json_schema?.schema;
  if (!schema) return { wireSchemaHash: null, wireSchemaBytes: null };
  const serialized = JSON.stringify(schema);
  return { wireSchemaHash: createHash("sha256").update(serialized).digest("hex"), wireSchemaBytes: Buffer.byteLength(serialized) };
}

module.exports = { providerProtocolMetadata, providerWireSchemaMetadata };

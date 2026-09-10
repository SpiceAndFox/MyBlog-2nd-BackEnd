const { usesTodoV2 } = require("../../contracts/outputProtocol");
const { validateSemanticResult } = require("../../contracts/semantic");
const { semanticToTodoV2, todoV2RepairErrors } = require("./todoWireProtocolV2");
const { semanticOutputToFlatWire, flatWireRepairErrors } = require("./flatWireProtocol");

// Business preflight runs on Semantic IR. Retry feedback must refer to the
// provider's original wire shape, while retaining transport/protocol metadata.
function providerBusinessRejection(result, validation, task) {
  const todoV2 = usesTodoV2(task);
  const canEncode = validateSemanticResult(result.output, task).ok;
  const wire = result.wireOutput ?? (todoV2
    ? (canEncode ? semanticToTodoV2(result.output, task) : undefined) : semanticOutputToFlatWire(result.output, task));
  const mapped = todoV2 ? todoV2RepairErrors(validation.errors, wire)
    : flatWireRepairErrors(validation.errors, wire, task);
  const errors = mapped.map(issue => {
    const match = issue.path.match(todoV2 ? /^\$\.results\.todos\.changes\[(\d+)\]/ : /^\$\.changes\[(\d+)\]/);
    const change = match ? (todoV2 ? wire?.results?.todos?.changes : wire?.changes)?.[Number(match[1])] : null;
    return { ...issue, ...(change ? { meta: { ...issue.meta, action: change.action,
      ...(change.target ? { target: change.target } : {}) } } : {}) };
  });
  return { errors, rejectedOutput: wire,
    rejectedOutputKind: wire === undefined ? "unavailable" : result.wireOutput === undefined ? "semantic_reencoded" : "provider_wire",
  };
}

module.exports = { providerBusinessRejection };

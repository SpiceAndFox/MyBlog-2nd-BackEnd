const { usesTodoV2 } = require("../../contracts/outputProtocol");
const { validateSemanticResult } = require("../../contracts/semantic");
const { semanticToTodoV2, todoV2RepairErrors } = require("./todoWireProtocolV2");
const { semanticOutputToFlatWire, flatWireRepairErrors } = require("./flatWireProtocol");
const { PROFILE_SPECIALISTS } = require("./profileSpecialists");

// Business preflight runs on Semantic IR. Retry feedback must refer to the
// provider's original wire shape, while retaining transport/protocol metadata.
function providerBusinessRejection(result, validation, task) {
  if (task.proposer === "profileRelationshipProposer") return profileBusinessRejection(result, validation, task);
  const todoV2 = usesTodoV2(task);
  const canEncode = validateSemanticResult(result.output, task).ok;
  const wire = result.wireOutput ?? (canEncode
    ? (todoV2 ? semanticToTodoV2(result.output, task) : semanticOutputToFlatWire(result.output, task)) : undefined);
  const mapped = todoV2 ? todoV2RepairErrors(validation.errors, wire)
    : flatWireRepairErrors(validation.errors, wire, task);
  const errors = mapped.map(issue => {
    const match = issue.path.match(todoV2 ? /^\$\.results\.todos\.changes\[(\d+)\]/ : /^\$\.changes\[(\d+)\]/);
    const change = match ? (todoV2 ? wire?.results?.todos?.changes : wire?.changes)?.[Number(match[1])] : null;
    const relatedPath = issue.meta?.relatedPath
      ? (todoV2 ? todoV2RepairErrors([{ path: issue.meta.relatedPath }], wire)
        : flatWireRepairErrors([{ path: issue.meta.relatedPath }], wire, task))[0].path : null;
    return { ...issue, meta: { ...issue.meta,
      ...(relatedPath ? { relatedPath } : {}),
      ...(change ? { action: change.action, ...(change.target ? { target: change.target } : {}) } : {}),
    } };
  });
  return { errors, rejectedOutput: wire,
    rejectedOutputKind: wire === undefined ? "unavailable" : result.wireOutput === undefined ? "semantic_reencoded" : "provider_wire",
  };
}

function profileBusinessRejection(result, validation, task) {
  const specialistOutputs = {};
  const errors = [];
  for (const specialist of PROFILE_SPECIALISTS) {
    const specialistTask = { ...task, proposer: specialist.proposer, targetSections: [specialist.section] };
    const original = result.specialistOutputs?.[specialist.proposer];
    const output = result.output?.sectionResults ? {
      tickId: task.tickId, proposer: specialist.proposer,
      sectionResults: { [specialist.section]: result.output.sectionResults[specialist.section] },
    } : undefined;
    const localErrors = (validation.errors || []).filter(issue => {
      const section = issue.meta?.section || String(issue.path).match(/^\$\.sectionResults\.([A-Za-z0-9_]+)/)?.[1];
      // A sectionless issue cannot safely be assigned to just one specialist.
      return !section || section === specialist.section;
    });
    const mapped = providerBusinessRejection({ output, wireOutput: original?.output }, { errors: localErrors }, specialistTask);
    specialistOutputs[specialist.proposer] = {
      output: mapped.rejectedOutput, outputKind: original?.outputKind || mapped.rejectedOutputKind,
      ...(original?.protocol ? { protocol: original.protocol } : {}),
    };
    errors.push(...mapped.errors.map(issue => ({ ...issue,
      meta: { ...issue.meta, section: specialist.section, specialist: specialist.proposer },
    })));
  }
  return { errors, rejectedOutput: { specialistOutputs }, rejectedOutputKind: "specialist_bundle" };
}

module.exports = { providerBusinessRejection };

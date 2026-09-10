const { isFlatWireProposer } = require("./flatWire");

function usesTodoWireProtocol(task) { return task?.proposer === "todoProposer"; }

// Diagnostic labels describe the current format; task metadata never selects
// an alternate implementation or an archived prompt.
function outputProtocolForProposer(proposer) {
  if (proposer === "todoProposer") return "todo";
  return isFlatWireProposer(proposer) ? "flat" : "semantic";
}

module.exports = { outputProtocolForProposer, usesTodoWireProtocol };

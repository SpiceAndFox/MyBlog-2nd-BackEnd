const { isAbortedIncompleteJson } = require("./providerProtocol");

function strictParseError(content, finishReason) {
  return isAbortedIncompleteJson(content, finishReason)
    ? "content_incomplete_json"
    : "content_invalid_json";
}

function scanLeadingJsonValue(value) {
  const text = String(value ?? "");
  let start = 0;
  while (start < text.length && /\s/.test(text[start])) start += 1;
  if (!["{", "["].includes(text[start])) return { status: "invalid" };

  const stack = [text[start]];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    const expected = character === "}" ? "{" : "[";
    if (stack.pop() !== expected) return { status: "invalid" };
    if (stack.length === 0) {
      return {
        status: "complete",
        json: text.slice(start, index + 1),
        trailing: text.slice(index + 1),
      };
    }
  }
  return { status: "incomplete" };
}

function isMarkdownFenceFragment(value) {
  return /^```(?:json)?\s*$/i.test(String(value ?? "").trim());
}

function isIncompleteJsonFragment(value) {
  return scanLeadingJsonValue(value).status === "incomplete";
}

function isRecoverableTrailingFragment(value) {
  const trailing = String(value ?? "");
  if (!trailing.trim()) return false;
  return isMarkdownFenceFragment(trailing) || isIncompleteJsonFragment(trailing);
}

function parseStrictJsonContent(content, { finishReason } = {}) {
  try {
    return {
      output: JSON.parse(content),
      transportError: null,
      transportRecovery: null,
      schemaValidation: null,
    };
  } catch {
    return {
      output: null,
      transportError: strictParseError(content, finishReason),
      transportRecovery: null,
      schemaValidation: null,
    };
  }
}

function parseJsonObjectContent(content, {
  finishReason,
  validateCandidate,
} = {}) {
  const strict = parseStrictJsonContent(content, { finishReason });
  if (!strict.transportError || typeof validateCandidate !== "function") return strict;

  const leading = scanLeadingJsonValue(content);
  if (leading.status !== "complete" || !isRecoverableTrailingFragment(leading.trailing)) return strict;

  let candidate;
  try {
    candidate = JSON.parse(leading.json);
  } catch {
    return strict;
  }
  const schemaValidation = validateCandidate(candidate);
  if (schemaValidation?.ok !== true) return strict;

  return {
    output: candidate,
    transportError: null,
    transportRecovery: "accepted_schema_valid_json_prefix",
    schemaValidation,
  };
}

module.exports = {
  isRecoverableTrailingFragment,
  parseJsonObjectContent,
  parseStrictJsonContent,
  scanLeadingJsonValue,
};

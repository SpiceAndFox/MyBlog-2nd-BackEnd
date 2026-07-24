// OpenCode Go 网关的上游 guided decoding 唯一不支持的约束关键字是 uniqueItems
// （携带即 HTTP 400；minLength/maxLength/minItems/maxItems/pattern/enum/const/oneOf 均实测可用）。
// 剥离 uniqueItems 并把约束折进 description 保留语义，与 deepSeekSchemaCompiler 的处理一致。
function compileOpencodeGoSchema(node) {
  if (Array.isArray(node)) return node.map(compileOpencodeGoSchema);
  if (!node || typeof node !== "object") return node;
  const compiled = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "uniqueItems") continue;
    compiled[key] = compileOpencodeGoSchema(value);
  }
  if (node.uniqueItems === true) {
    compiled.description = [compiled.description, "Array items must be unique."].filter(Boolean).join(" ");
  }
  return compiled;
}

module.exports = { compileOpencodeGoSchema };

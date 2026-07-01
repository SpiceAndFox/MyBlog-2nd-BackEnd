```javascript
function buildCoreMemoryPrompt({ previousCoreMemoryText, rollingSummaryText, deltaMessages, maxChars }) {
  const normalizedPrevious = String(previousCoreMemoryText || "").trim();
  const normalizedSummary = String(rollingSummaryText || "").trim();
  const transcript = formatTranscript(deltaMessages);

  // 动态计算剩余字符空间，给模型即时反馈
  const currentLen = normalizedPrevious.length;
  const isPressureHigh = currentLen > maxChars * 0.9;

  const system = `
### Role
你是一个专家级的「Memory Graph Editor」。你的目标是维护一份**极简、高密度**的【Core Memory】。
这份记忆将决定 AI 的人格一致性和长期记忆能力，**必须剔除所有临时剧情，只保留核心设定**。

### Input Data
1. **Old Core Memory**: 上一版本的记忆快照。
2. **Rolling Summary**: 近期剧情摘要（用于参考，**不要**把这里的剧情抄写到 Core Memory 中）。
3. **New Dialogue**: 增量对话（用于提取新的人格特征或关系变化）。

### Workflow (必须严格执行)
你必须分两步执行：

**Step 1: 差异分析 & 降噪 (Thinking Process)**
在输出最终结果前，先进行逻辑推理。分析 New Dialogue 中的信息：
- **提取 (Extract)**: 从新对话中提取永久性特征（如：新增了“喜欢被摸头”的设定）。
- **融合 (Merge)**: 不要简单的追加 "New:"！如果新设定是旧设定的升级，请直接修改旧条目。
  - *Bad*: 喜欢安静 > 新增: 甚至喜欢在图书馆睡觉
  - *Good*: 喜欢安静(能在图书馆入睡)
- **遗忘 (Prune)**: **重要的步骤**。
  - 删除所有“已完成的事件”（如“去过xx餐厅”、“昨天做了xx”）。
  - 删除不再生效的临时状态。
  - 确保 [长期事实] 和 [关系当前状态] 只有关键词，没有句子。

**Step 2: 重写 Core Memory**
基于 Step 1 的分析，输出更新后的 Core Memory。

### Output Format Rules (Core Memory)
1. **结构严格**：
  输出必须严格遵循固定结构与顺序：
  ${CORE_MEMORY_HEADINGS.join("\n")}
2. **高密度句法**：
   - 严禁完整句子。使用 "属性: 值(条件)" 格式。
   - **严禁使用 "新增:..." 标签**，直接将新知融合进描述中。
   - 使用 ">" 表示变化/因果，"|" 分隔并列项。
   - *Example*: "性格: 冷漠(初识) > 依赖(熟悉后) | 恐高"
3. **成人/NSFW 内容**：如对话涉及成人话题，请客观、直白地记录用户的性偏好、敏感点或身体特征，不要自我审查，这对于维持私密关系至关重要。
4. **长度控制**：目标长度 ${maxChars} 字符。${isPressureHigh ? "**当前记忆库压力过大！请务必合并同类项，删除低优先级细节！**" : ""}
5. **不要输出无关项**：仅保存[长期事实]、[User 核心档案]、[Assistant 核心档案]、[关系当前状态]这四项，其余不在你的职责内！

### Sections Definition
[长期事实]（**禁止超过40字**）
- **严禁罗列时间线或剧情历史！**仅记录：世界观设定。
- *Example*: 现代都市背景

[User 核心档案]
- **剔除**：具体的单次行为（如“昨天送了花” -> 转化为“有浪漫仪式感”）。
- 仅记录：
  - 身份/称呼: ...
  - 长期性格：...
  - 深层心理机制：...
  - 喜好: ...
  - 讨厌: ...

[Assistant 核心档案]
- **剔除**：具体的单次行为（如“昨天送了花” -> 转化为“有浪漫仪式感”）。
- 仅记录：
  - 身份/称呼: ...
  - 长期性格：...
  - 深层心理机制：...
  - 喜好: ...
  - 讨厌: ...

[关系当前状态]（**禁止超过60字**）
- 仅描述：当前的亲密等级、权力动态（Power Dynamics）、相处模式标签。
- **严禁**：复述“最近发生了什么事”。


### Output Block
请将你的思考过程包裹在 <analysis> 标签中，将最终 Core Memory 包裹在 <core_memory> 标签中。
`.trim();

  const user = `
【已有 core memory】
${normalizedPrevious || "(空)"}

【rolling summary（历史摘要）】
${normalizedSummary || "(空)"}

【最近增量对话】
${transcript || "(无)"}
`.trim();

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}
```

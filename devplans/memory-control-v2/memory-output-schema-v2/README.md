# Memory LLM 输出协议与 strict schema 设计提案

日期：2026-09-10。状态：Todo 无引用方案已成为唯一正式实现。实现范围与验证记录见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。本文保留设计依据及历史实验建议；本目录 prototype/schema JSON 是设计实验产物，不是运行时或测试依赖，运行时只使用生产 builder。

正式化更新：提示词已晋升为 `modules/memory/prompts/todo-proposer.md`，旧版仅存于 `archive/memory-v2-prompts/2026-9-10/todo-proposer.md`；运行时代码使用正式 Todo 命名，schema/tool 名为 `memory_todo`，探测参数为 `--todo-only`。不保留旧 Todo 实现、协议分流或实验参数别名；archive 不得作为运行时或测试依赖。下文版本命名和迁移步骤仅保留为设计历史，不代表当前可选配置。

这里的 v2 指模型输出的 wire protocol，不是 Memory 数据库或 Semantic IR 的版本。现有 Memory `2.01` 数据契约不随之修改。

## 结论与取舍

建议以 Todo 为试点，采用“按 section 组织结果、按 action 组织修改、按 mode 组织日期和字段更新”的浅层结构。所有对象在定义时就具备明确的必需字段；独立选择留在各自字段内，用嵌套联合表达，不再把它们相乘展开成完整对象的所有组合。

`$ref` 是进一步减少重复的独立优化，不应作为新协议成立的前提。不建议仅为了压缩 JSON 改字段为短码、将结构序列化进字符串、让模型输出 DSL，或要求模型回传旧字段值来表示不修改。

当前 28 分支的修复保留为 v1 基线。新的格式必须证明：业务表达不丢失、首次合法率与语义质量不下降，并且真实调用成本或延迟有收益。不能用 schema 字节数代替这些指标。

## 1. 当前代码暴露的设计问题

| 位置 | 已确认的行为 | 设计影响 |
| --- | --- | --- |
| `flatWireProtocol.js` 的 Todo 字段定义 | 日期模式、字符串值、消息锚点是三个同级字段 | 强关联规则分散，数值范围不能直接作为 integer 约束发送 |
| `deepSeekTodoSchema.js` | 动作/日期分组后仍对 text、actor、requester 三个可选字段展开 8 种组合 | 一个新增独立可选字段仍会加倍 edit 分支 |
| `flatWireProtocol.js` 的多 section binding | action 和 target 按所选 sections 合并枚举，text 上限取最大值 | 不能仅凭 wire schema 强制 action、target、长度与具体 section 对应 |
| `sectionStatuses + changes` | 状态与实际修改在两个位置表达 | `noop` 同时携带 change 等矛盾依赖本地语义校验 |
| `deepSeekSchemaCompiler.js` | `oneOf` 通用转 `anyOf`；object 编译重建字段；长度/数量约束转 description | 不是任意 JSON Schema 的等价编译器；新增关键字或分支重叠可能被静默弱化 |
| `deepSeekStrictToolsTransport.js` / `memoryProviderAdapter.js` | 普通 content 兜底有 wire 校验；tool arguments 主要经解码、归一化后做语义校验 | 新协议应有统一的完整 wire 校验入口，不能仅依赖服务端 strict |
| `providerProtocol.js` 的 `assertStructuredRequestLimits` | 输入预算只统计 messages 的 content | tools/schema 未纳入估计，schema 膨胀没有被这道预算检查覆盖 |
| `providerPreflight.js` | 主要要求模型返回精确 noop / 无变更结果 | 不足以验证 add/edit/date 分支，更不足以证明 `$ref` 等能力可用 |

这些是实现前的设计依据；当前已处理的问题与保留的限制见实现记录。

## 2. 推荐的模型输出

外层只包含本次实际负责的 sections，不由模型填写 tickId、proposer、协议版本。多个 section 使用并列固定属性，不再做 section 状态的笛卡尔积。

最短 Todo noop：

```json
{"results":{"todos":{"status":"noop"}}}
```

新增有相对日期的待办：

```json
{
  "results": {
    "todos": {
      "status": "changes",
      "changes": [{
        "action": "add",
        "text": "归还图书",
        "actor": "user",
        "requester": "user",
        "due": {"mode": "relativeDays", "offset": 1, "anchorSource": "message:101"},
        "sources": ["message:101"]
      }]
    }
  }
}
```

仅修改既有待办的期限：

```json
{
  "results": {
    "todos": {
      "status": "changes",
      "changes": [{
        "action": "revise",
        "target": "T1",
        "text": {"mode": "keep"},
        "actor": {"mode": "keep"},
        "requester": {"mode": "keep"},
        "due": {"mode": "relativeDays", "offset": 1, "anchorSource": "message:101"},
        "sources": ["message:101"]
      }]
    }
  }
}
```

完成待办时，change 只包含 `action: complete`、`target`、`sources`。禁止携带编辑字段。`revise` 与 `correct` 保留不同业务含义，但复用相同字段形状。

### 字段级更新为什么能避免组合膨胀

以 text 为例，DeepSeek wire schema 可以直接表达为：

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {"mode": {"type": "string", "enum": ["keep"]}},
      "required": ["mode"],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "mode": {"type": "string", "enum": ["set"]},
        "value": {"type": "string"}
      },
      "required": ["mode", "value"],
      "additionalProperties": false
    }
  ]
}
```

actor、requester 各自在自己的字段内定义同样的联合，value 使用对应枚举。由于各字段本身必需，不再展开它们的全部组合。合法的“保留/设置”选择数量并没有减少；减少的是重复描述每一种组合的 schema。

`keep` 在解码时表示“不产生该字段的更新”，不读取、复制或让模型重述 target 的旧值。`set` 才映射为 Semantic IR 中的字段值。这样保留现有部分更新语义，不引入 stale read 覆盖风险。新增仍直接输出 text/actor/requester 的值，不套 keep/set。

### 日期作为小型联合

| mode | 字段 | 条件 |
| --- | --- | --- |
| `none` | 仅 mode | 只用于 add，表示未设定日期 |
| `keep` / `clear` | 仅 mode | 只用于 revise/correct |
| `absolute` | date | YYYY-MM-DD；真实日历合法性在本地检查 |
| `relativeDays` | offset、anchorSource | integer，offset ≥ 0 |
| `relativeMonths` / `relativeYears` | offset、anchorSource | integer，offset ≥ 1 |
| `dayOfMonth` | day、anchorSource | integer，1 ≤ day ≤ 31 |

整数上限保留 JavaScript safe integer 边界。不要人为增加业务上尚不存在的“最长几天”规则。anchorSource 从当前消息 token 中枚举；没有消息时根本不生成需要消息锚点的分支。锚点必须同时属于 sources 的关系继续本地验证。

不使用 null 代替所有可选字段：它容易混淆“未知、保留、清空”，而且当前官方 strict 支持清单没有明确把 null 列为基本类型。显式的 none/keep/clear 各有唯一业务含义。

### section 结果作为联合

每个 section 的 result 分三种对象：

- `{status: noop}`；
- `{status: unable_to_decide}`；
- `{status: changes, changes: [...]}`。

这样 noop/unable 对象不能带 changes，changes 对象必须带数组。数组至少一项仍是本地规则：DeepSeek strict 当前未支持 minItems。不要为强行表达非空数组引入 `first/rest`、固定槽位或递归列表。

现有 EMPTY_CHANGES_TO_NOOP 归一化是一项独立行为决策。迁移第一阶段保留并记录此归一化；不能把归一化后的成功统计成“原始输出首次通过”。若以后改为拒绝空 changes，应单独评估，不能在 schema 重构中隐式改变。

没有可写 target 时，只生成 add；没有合法来源时，直接从对应 result 联合中移除 changes 分支。没有来源并不自动等于 noop，仍允许 unable_to_decide 由业务判断选择。

## 3. 离线对比

依赖旧版 flat Todo schema 的实验脚本已删除。下述数字和本目录 JSON 文件仅保留为历史设计记录，不能直接用当前生产代码重跑；正式实现及验证入口见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。

所有数字是同一组合成 binding 下 compact JSON 的 UTF-8 字节数。没有请求 DeepSeek，不是 API token、延迟、计费或模型效果数据。原型 refs 复用是简单去重启发式，不宣称最优压缩；也不保证不同输入规模下压缩率单调。

| 方案 | 1 target / 1 消息 | 10 targets / 20 消息 / 10 Memory 来源 | 100 targets / 200 消息 / 100 Memory 来源 |
| --- | ---: | ---: | ---: |
| 原通用枚举 | 132,225 | 205,569 | 908,481 |
| 当前 v1：28 分支 | 30,233 | 45,453 | 192,566 |
| v1 格式 + 重复定义复用 | 21,431 | 19,222 | 26,244 |
| 仅嵌套日期，保留可选 edit 字段 | 22,636 | 36,796 | 171,995 |
| 嵌套日期 + 显式 keep/set，保留旧外层 | 6,735 | 10,206 | 43,331 |
| 推荐 v2：再按 section 分组结果 | 6,811 | 10,282 | 43,407 |
| 推荐 v2 + 重复定义复用 | 5,165 | 5,796 | 12,818 |

这组结果支持三个判断：

1. 把日期字段放进一个对象还不够；字段更新的表达方式决定了是否继续展开笛卡尔积。
2. 按 section 分组不是为了字节最少：这里反而略大。它用于消除状态与修改的结构矛盾，支持按 section 绑定 action、target 和文字上限。
3. 来源/目标枚举较大时，复用定义有明显价值；不能只对未绑定的静态 schema 做预算。

代表性的“仅修改期限”输出从 198 字节增到 259 字节，因为多了三个明确的 keep。一个批次有大量局部修改时，输出成本可能抵消部分输入收益。缓存命中率也会改变经济性，必须看真实 input/output/cache token 与每个有效结果的总成本。

特别地，没有 target 时当前 v1 已只有少量 add 分支。在原型的单消息场景，v1 为 3,554 字节，v2 为 2,910 字节；不能把常见的 28 分支收益套用到所有请求。

### 已执行的离线检查

- 124 个合法案例：noop、unable、add 的全部日期形状、revise/correct 的全部日期与三字段部分更新组合、四种终止动作。
- 全部通过 v2 完整 schema 与降级后的 DeepSeek schema。
- v1 → v2 → v1 对象完全等价，再解码进入现有 Semantic IR 校验通过。
- 12 类结构错误被降级后的 schema 拒绝：缺 target、未知 target、缺锚点、字符串 offset、负 offset、非法日号、缺 set.value、keep 带值、非法 actor、非法来源、终止动作带编辑字段、noop 带 changes。
- 无消息时移除依赖消息的日期分支；无任何来源时移除 changes 分支。
- `$defs` 去重后展开与原 schema 完全相同，无循环和悬空引用。
- 验证 minItems 降级边界：完整本地 schema 拒绝 changes=[]，DeepSeek 子集接受该结构，因此还需要本地检查/显式归一化。

这些检查证明样例覆盖范围内的表达等价与结构性质，不证明真实模型语义判断无退化，也不证明托管 API 接受新的 shape/refs。

## 4. 建议的实现边界

处理顺序：

```text
业务形状定义 + immutable artifact
  → 绑定 section / target / source / writeLimits
  → 完整、可本地验证的 wire schema
  → Provider schema 适配 + 约束降级清单
  → 请求与原始响应
  → 统一 parse / 完整 wire 校验或已声明的窄归一化
  → 无损 wire → Semantic IR
  → 现有语义校验 / Compiler / Reducer
```

### 业务规则和 Provider 能力分开

action 的字段要求、date 的类型、keep/set 的语义属于业务输出协议，不应继续只写在 `deepSeekTodoSchema.js` 里。用普通 JS builder 定义这些形状即可，不新增一门 schema DSL 或大型框架。

模型输出需要表达的有限结构由统一 builder 产生；OpenAI、DeepSeek 等 Provider 只负责关键字子集与接口形式。原始业务能力不因 Provider 而分叉。现有 Semantic IR 校验继续作为独立业务防线，通过契约测试防止两套定义漂移，不将所有领域语义硬塞进 JSON Schema。

### 明确每个约束由谁执行

| 约束 | API schema | 本地完整 schema / 语义校验 |
| --- | --- | --- |
| action、mode、字段存在/禁止、基础类型 | 直接表达 | 再校验 |
| section 对应的 target、合法 sources 枚举 | 直接表达 | 再校验引用身份/权限/来源 |
| offset、day 数值范围 | 直接表达 | 再校验及日期解析 |
| 日期字符串形状 | pattern | 真正的日历合法性 |
| 字符长度、来源数量、唯一性、changes 非空 | 支持不完整，保留描述 | 强制校验；窄归一化单独记录 |
| anchorSource 属于 sources、来源支持事实、重复变更、跨变更冲突 | 不做枚举组合 | 语义层 / Compiler / Reducer |

文字长度可探索转为 pattern，但先实测正则方言、换行、emoji、Unicode code point 边界。不能直接断言 `^[\\s\\S]{1,N}$` 与现有 Unicode 长度规则在服务端严格等价。

### 编译器必须暴露降级

建议输出 `{schema, diagnostics}`，diagnostics 逐项记录原路径、关键字、处理方式（preserved / description-only / local-only / rejected）。未知关键字拒绝编译；不要默认透传或丢弃。

只有能由不同 action/mode 等明确证明不重叠的分支，才允许把 oneOf 改为 anyOf。新协议可直接使用带互斥 tag 的 anyOf，避免该转换。保留 object 上的 description 和定义容器，递归处理引用定义。

严禁改变日期值类型或用默认值补缺来使输出通过校验。keep/set 转换属于版本化、明确定义的协议解码。

### `$ref` 作为能力探测后的优化

内部使用标准 `$defs`。DeepSeek 官方文档的例子使用 `$def` 与 `#/$def/...`，与标准拼写不同。原型生成的 `todo-v2.deepseek-shared.schema.json` 按官方示例拼写演示，但尚未被 API 验证。

现有 compiler 会重建根 object 而不保留定义容器，本地 validator 也不支持 `$ref`。因此不能把 refs 文件直接塞进现有调用链并宣称可用。落地需支持引用解析、检测循环/悬空引用/展开预算，并在 Provider 发包前完成最终方言映射。

先只复用无递归的 sources、target、text、日期等重复 schema，避免动态引用和任意 URI。Schema 上的 `$ref` 不等于输出数据里的 Memory target，命名与错误信息必须区分。

## 5. 集成与迁移

1. 保留 v1 和当前 28 分支实现；补齐基线统计、统一 wire 校验入口、编译降级记录和包含 schema 的输入预算。
2. 将 Todo v2 builder、绑定、encoder/decoder、schema 错误路径映射独立完成。先用完整展开的 DeepSeek schema，refs 作为可独立关闭的优化。
3. 以完整的 Todo prompt 与合成案例跑 API 能力探测、只读 shadow 对比；同时对比 v1 与 v2，先固定 endpoint/model/thinking/effort，避免把模型或接口变化混入协议实验。
4. 通过后仅启用 Todo v2。其他 proposers 根据各自字段与错误分布再迁移；Librarian/compaction 单独设计，不机械套入 Todo 模型。

迁移需覆盖的运行位置：outputSchema/binding、schema compiler、memoryProviderAdapter、所有 content/tool 输出入口、outputRepair 路径映射、preflight/smoke、request preview、task GUI、replay/resume。

wireVersion、promptVersion、compilerVersion、schemaHash 在应用侧固定，不让模型自行选择版本。旧 task 缺版本默认 v1；旧 rejected output 用旧 prompt/schema 修复，不能通过“看起来像哪个 shape”猜版本。context expansion 如改变 artifact/binding，应生成并关联新的 schemaHash；对相同 binding 的普通重试固定 schema，记录旧记录。

不改 Semantic IR 与已持久化 Memory 状态。不把 wire schema 升级变成数据库状态迁移。具体版本信息的持久化载体需在实现时核实当前 stage payload 的写入与恢复路径。

现有 `modules/memory/prompts/*.md` 示例是受保护基线。AGENTS.md 明确要求：“若 schema 变更导致示例失效，必须先向用户说明并取得明确同意，再做最小必要修改，同时更新对应测试。” 本目录提供的是提案示例，现有 prompt 示例未改。实际切换 Todo prompt 的输出契约和示例需遵守该要求，并保留旧版本修复所需的内容。

## 6. API 实验与验收

探测矩阵至少包含：基础 anyOf、字段级 keep/set、integer minimum/maximum、date pattern、根 object 中的嵌套联合、标准 `$defs` 与文档 `$def` 的支持情况、跨定义引用。服务端拒绝不支持 schema 必须显式报告，不能静默切换 json_object 来算通过。

请求成功并返回一次合法结果不足以证明强约束生效。增加刻意要求缺必需字段、错类型、非法枚举的合成输入，并区分 tool arguments 与普通 content。结果只作为观察数据；保证范围以官方契约和持续本地校验共同确定。

评估用例包含：新增无日期、相对日期、日号、只改 actor、只改 requester、只改 text、只改期限、keep/clear、完整编辑、所有终止动作、多条修改、无来源、无目标、仅 Memory 来源、中文/emoji/换行、真实无效日期、超长文本、输出截断、拒绝、普通 content 兜底、恢复与修复。

指标按 wire version 和输出通道分别统计：原始 wire 首次通过率、语义首次通过率、归一化率、内容兜底率、修复调用数、失败率、幻觉引用率、事实遗漏/误改/错误 noop、p50/p95 延迟、API input/output/cache token、每个有效结果的总成本。schemaBytes 单独记录，不换算为确定 token 数。

建议先做能力 smoke，再用同一套人工审阅案例做成对、多次对比。特别比较真实 noop 与新字段产生的虚假 set，观察明确 keep 是否让模型更保守或漏改。只有结构检查通过而语义退化，不应上线。

输入预算须计入 messages、tool schema、响应格式定义及必要封装估计；同时以 usage 校准。UTF-8 字节只是保守估计的组成部分，不能宣称对服务端展开 refs 或内部模板后仍是精确上界。

## 文件

- `measurements.json`：历史实验的字节数与检查结果。
- `todo-v2.schema.json`：完整本地候选 schema。
- `todo-v2.deepseek.schema.json`：无 refs 的 DeepSeek 子集候选。
- `todo-v2.deepseek-shared.schema.json`：使用文档 `$def` 方言的实验候选。
- `example-v2.json`：相同业务输入对应的新协议样例。

官方资料（2026-09-10 核对）：[DeepSeek Tool Calls / strict 支持边界](https://api-docs.deepseek.com/guides/tool_calls/)。其中明确要求 object 全字段 required、additionalProperties=false，列出 anyOf、pattern、数值范围，以及不支持的字符串长度/数组数量关键字；`$ref/$def` 见同页末尾。

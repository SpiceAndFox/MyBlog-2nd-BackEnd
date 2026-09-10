# 子任务 04：Librarian 操作模型

## 状态与优先级

- 优先级：P2
- 状态：本地实现与验收完成，见 [08-implementation.md](./08-implementation.md)
- 前置：[02-provenance.md](./02-provenance.md) 的目标 evidence 语义
- 目标：用少量正交操作修复已有复合、重复和误分类 item

## 可写范围

首期继续只维护：

- `standingAgreements`
- `worldFacts`
- `userProfile`
- `assistantProfile`
- `relationship`

`recentEpisodes` 和 `milestones` 暂不加入 Librarian 可写范围，避免同时引入滑动窗口和时间语义。

## 操作集合

### `move`

保持 item 文本和当前 evidence 不变，移动到另一个已授权 section。

### `revise`

旧内容过去成立，但需要改写为新的当前表示。输出完整结果文本和授权 evidence。

### `correct`

旧内容从一开始就不准确。输出完整纠正文本和授权 evidence。

### `split`

- 允许所有 parts 留在原 section；
- 允许 parts 分别进入不同已授权 section；
- 每个 part 提供完整 text、目标 section 和 evidence ref 子集；
- 不复制源 item 的全部 evidence。

“parts 是否完整保留实质信息”属于模型要求和 eval，不写成 Compiler 能证明的语义保证。

### `merge`

将多个 item 合成一个完整结果，并显式选择授权 evidence。是否真正语义兼容由模型判断和 eval 负责。

### `remove`

首期只支持低风险、可定位 keeper 的重复移除：

```text
reason = duplicate
keeperRef = <仍保留的 item>
```

“误分类且不属于任何 section”的直接删除暂时只允许报告、不执行。只有真实样本 eval 证明风险可控后，才扩展新的 reason code，不预先建设通用 archive 通道。

## Evidence 输入

Renderer 为待处理 item 提供其当前直接 evidence 对应的、数量受限的原始消息摘录。该输入在 task 创建时一次性固定：

- 不使用交互式按需加载工具；
- 不加载整个历史对话；
- 模型只能选择 renderer 提供的 evidence 短引用；
- Compiler 只验证 evidence 是否在授权集合中，不判断语义充分性；
- revision 变化后整个 task stale。

## 编译与提交约束

所有操作只经过可机械证明的校验：

1. schema 和 action/section 组合；
2. target、keeper 和 evidence ref 权限；
3. 文本长度及 section 容量；
4. 一个 item 在同一 proposal 中最多参与一次结果操作；
5. base revision 乐观锁；
6. 原子事务提交和 event 记录。

不增加“语义兼容”“事实完整”“真正重复”等伪确定性校验。

## 验收标准

- 分类错误 item 可以 move 到已授权 section；
- 同 section 复合 item 可以 split；
- split/merge 只使用本 task 授权的 evidence；
- revise/correct 不传播全部历史来源；
- duplicate remove 必须带 keeper，并产生审计 event；
- 未支持的 archive/remove 原因只能报告或 noop；
- revision 变化后不能使用旧 ref 提交；
- replay 可以恢复相同权威 state。

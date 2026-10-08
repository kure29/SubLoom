# 导出器测试样本

位于 `packages/core/test/fixtures/export/`，每个用例一个目录，由 `test/export.golden.test.ts` 读取：

- `input.json`：一次完整的生成过程。节点来自 `fixtures/import` 下的某个用例（`subscription`）或直接给出（`nodes`），经过流水线（`pipeline`）后，与 profile 一起导出。profile 三选一：直接给出（`profile`）、来自预设模板（`template`）、或使用订阅中的策略组和规则（`importConfig: true`）。`options` 为导出选项。
- `expected.mihomo.yaml`：mihomo 导出结果快照。CI 对所有 `expected.mihomo.*` 执行 `mihomo -t`（见 `scripts/mihomo-check.sh`）。
- `expected.warnings.json`：流水线警告与导出警告（CompatWarning）快照。

与导入样本一样，**全部为虚构数据**。

| 用例 | 内容 |
|---|---|
| `airport-full/` | 典型机场下发的完整配置，原样导入后再导出；测试中还验证重新导入后 IR 不变 |
| `variants/` | 全部 11 种协议、各种传输层、extra、需要加引号的标量（`12e4`、`01234567`）；悬空的策略组成员被清理；同样验证往返 |
| `uri-common-zh/` | **验收用例**：URI 订阅 → 流水线（去掉信息节点、按地区排序、去重）→ 常用分流模板（中文）→ mihomo |
| `uri-minimal-en/` | Base64 订阅 → 流水线（按地区保留、改名、加前缀）→ 极简模板（英文），`defaultUdp: false` |
| `edge-common-en/` | `uri-edge-cases` 的节点（含重名）→ 常用分流模板（英文），重名节点自动改名 |
| `profile-features/` | 手写 profile：general/dns/extra 全部字段、手动节点、四种策略组、全部规则类型（含 `src`、`no-resolve`、嵌套逻辑规则）、三种规则集格式 |
| `cleanup/` | 需要清理的 profile：节点重名（含与组名、内置目标重名）、其他格式的 extra、悬空引用、重名的组、空组、不可用的规则集 |

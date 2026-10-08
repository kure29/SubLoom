# CLAUDE.md

SubLoom：可视化代理配置生成与托管工具。**`PLAN.md` 是唯一的设计依据**，开始任何工作前先读它。

## 工作约定

- **先改方案，再改代码**：实现中如有设计变更，先更新 `PLAN.md`，再改代码。
- **按里程碑推进**：只做当前里程碑（PLAN.md 第 9 节）的内容，不要提前实现后续里程碑的功能。
- **不确定就问**：方案里没写清楚、需要做决定的地方，先列出来问用户，不要自己猜。
- **勾选进度**：每个里程碑完成后，在 `PLAN.md` 第 9 节勾选对应的完成项（`- [ ]` → `- [x]`），与代码在同一个 PR 中提交。
- 提交前确保验收命令全部通过：`pnpm lint && pnpm typecheck && pnpm test && pnpm build`。
- **不得丢失未提交或未推送的内容**：未经用户确认，不得执行 `git clean`、`git reset --hard`、`git checkout -- .`、强制推送（`push --force` / `--force-with-lease`）等会丢弃工作区、未提交或未推送内容的命令。需要在干净环境中验证时，先提交，或者在单独的目录里 clone 后再验证。
- 本文件与 `AGENTS.md`（由 turbo 自动维护）冲突时，以本文件为准。

## 硬性约束

- `packages/core` 和 `packages/server` **禁止使用任何 Node 专有 API**（`Buffer`、`fs`、`path`、`crypto` 模块、`process` 等）。只能用 Web 标准 API：`fetch`、`TextEncoder`、`crypto.subtle`、`atob/btoa`、`URL`。
- **禁止 `eval` / `new Function`**（Workers 不支持）。
- Node 专有代码只能出现在 `apps/node`；Workers 专有代码只能出现在 `apps/worker`。
- core 中的每个导入器和导出器都必须有 golden 测试。

这些约束由工具强制执行，**不要为了绕过而关闭规则或添加 ignore 注释**：

| 机制 | 作用范围 | 拦截内容 |
|---|---|---|
| tsconfig：`lib: ["ES2023", "WebWorker"]`，不引入 `@types/node` | `packages/*` | `Buffer`、`process`、`node:*` 等在 typecheck 时报错 |
| Biome `noNodejsModules` + `noRestrictedGlobals` | `packages/*/src`、`packages/*/test`、`apps/web/src`、`apps/worker/src` | 导入 Node 内置模块；使用 `Buffer`、`process`、`require`、`__dirname` 等全局 |
| Biome `noRestrictedImports` | `packages/*`、`apps/node`、`apps/web` | 导入 `cloudflare:*` |
| Biome `noGlobalEval`、`noImpliedEval`、`noRestrictedGlobals(Function)` | 全仓库 | `eval`、`new Function`、字符串形式的 `setTimeout` |

`packages/db` 同时被 Node（better-sqlite3）和 Workers（D1）使用，因此也按 core/server 的标准禁止 Node API。上述限制同样适用于 `packages/*/test` 中的测试代码。

## Golden 测试约定

core 的导入器和导出器用 golden 测试覆盖，测试代码同样不得使用 `fs` 等 Node API：

- 目录：`packages/core/test/fixtures/<case>/`，输入为 `input.*`，期望输出为 `expected.<target>.*`（如 `expected.mihomo.yaml`）。
- **读取输入**：用 Vite 的 `import.meta.glob`，以 `?raw` 方式读取，例如 `import.meta.glob('./fixtures/*/input.*', { query: '?raw', import: 'default', eager: true })`（需在 core 的 tsconfig `types` 中加入 `vite/client`）。
- **期望输出**：用 Vitest 的 `expect(text).toMatchFileSnapshot('./fixtures/<case>/expected.<target>.<ext>')` 写成独立文件，不使用内联快照或 `.snap` 文件。
- **更新快照**必须是有意为之：用 `pnpm --filter @subloom/core exec vitest run -u`，并在提交前逐个检查快照文件的 diff。
- **mihomo 实际校验**：CI 直接对所有 `expected.mihomo.*` 快照文件执行 `mihomo -t`。

## 仓库结构

```
packages/core     @subloom/core    IR、导入器、导出器、流水线、能力矩阵（纯 TS）
packages/db       @subloom/db      Drizzle schema + 迁移
packages/server   @subloom/server  Hono 应用工厂 createApp(platform)，与运行时无关
apps/web          @subloom/web     前端（Vite + React），private
apps/node         @subloom/node    Docker 入口，private
apps/worker       @subloom/worker  Cloudflare Workers 入口，private
```

## 常用命令

需要 Node 24（见 `.nvmrc`）和 pnpm 10（版本由 `package.json` 的 `packageManager` 字段固定）。

```sh
pnpm install            # 安装依赖
pnpm lint               # Biome lint + 格式检查（全仓库）
pnpm format             # Biome 自动修复 lint 与格式问题
pnpm typecheck          # 各包 tsc --noEmit（turbo）
pnpm test               # 各包 vitest run（turbo）
pnpm build              # 各包构建（turbo）

pnpm --filter @subloom/core test          # 只跑某个包的任务
pnpm --filter @subloom/core exec vitest   # watch 模式
pnpm --filter @subloom/web dev            # 前端开发服务器
pnpm --filter @subloom/worker dev         # wrangler dev
```

## 代码与依赖约定

- 全仓库 ESM（`"type": "module"`），TypeScript strict（另开启 `noUncheckedIndexedAccess`、`verbatimModuleSyntax`）。
- 格式：单引号、无分号、2 空格缩进、行宽 100，由 Biome 统一，不要手动调整。
- `packages/*` 与 `apps/node` 使用 `NodeNext` 模块解析：**相对导入必须带 `.js` 扩展名**（如 `import { x } from './ir/index.js'`）。`apps/web`、`apps/worker` 由打包器处理，使用 `Bundler` 解析。
- `packages/*` 用 `tsc -p tsconfig.build.json` 输出到 `dist/`（ESM + `.d.ts`），`exports` 指向 `dist`。turbo 的 `typecheck`、`test`、`build` 都依赖上游包先 build。
- 共用的依赖版本统一写在 `pnpm-workspace.yaml` 的 `catalog` 中，包内用 `"catalog:"` 引用。
- Vitest 固定在 4.x：M5 需要的 `@cloudflare/vitest-pool-workers` 目前只支持 `vitest ^4.1`，升级前先确认兼容性。
- 测试文件放在各包的 `test/` 目录，命名 `*.test.ts`。
- 工具链版本可能比你的训练数据新。修改 Turborepo 配置前先读已安装包内的文档（`node_modules/turbo/docs/`，见 `AGENTS.md`，该文件由 turbo 自动维护）；其他工具同理，以已安装版本的文档和 schema 为准。

# SubLoom 项目方案

> **SubLoom**：可视化代理配置生成与托管工具。Loom 意为织布机，把订阅、规则、策略组"织"成各个客户端的配置。
> 本文件是项目的总体方案，供开发时（包括 Claude Code）作为唯一参考。
> 实现过程中如有设计变更，先更新本文件，再改代码。

---

## 1. 项目目标

一个**开源、自部署**的代理配置工具：

- 在浏览器里**可视化编辑**策略组、规则、规则集、DNS 等配置。
- 一份配置**导出到多个客户端**：mihomo、Surge、Shadowrocket、Loon（后续加 sing-box、Quantumult X）。
- 后端**托管订阅链接**：拉取机场订阅、处理节点、按客户端生成配置，客户端通过链接定时更新（类似 Sub-Store）。
- 每个用户**自己部署**，支持 **Docker** 和 **Cloudflare Workers** 两种方式。项目方不运营公共实例。

### 非目标

- 不做多用户/多租户，不做公共托管服务。
- 不提供、不推荐任何节点或机场。
- v0.1 不做本地纯前端模式（以后再考虑）。

### 核心原则

1. **一份模型，多端导出**：用户编辑的是与客户端无关的中间模型（IR），客户端只是导出目标。
2. **透明降级**：目标客户端不支持某功能时，导出器给出明确警告，界面展示，绝不静默丢弃。
3. **一套代码，两个运行时**：server 代码与运行时无关，平台差异全部收敛到 `Platform` 接口。
4. **部署要简单**：Docker 一条命令；Workers 一键部署按钮；升级时自动迁移数据库。

---

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 包管理 | pnpm workspaces + Turborepo | monorepo |
| 语言 | TypeScript（strict） | 全项目统一 |
| 代码规范 | Biome | lint + format |
| 测试 | Vitest | core 用 golden 文件测试；Workers 用 `@cloudflare/vitest-pool-workers` |
| 校验/模型 | zod | IR schema 即校验 |
| YAML | `yaml` | 支持保留注释，可在 Workers 运行 |
| 后端框架 | Hono | 同时运行于 Node 和 Workers |
| ORM | Drizzle（sqlite-core） | Docker 用 better-sqlite3，Workers 用 D1，共用 schema |
| Node 运行时 | Node 24 LTS（`@hono/node-server`） | Docker 镜像 |
| 前端 | React + Vite + TypeScript | |
| UI | shadcn/ui + Tailwind CSS | |
| 前端状态 | Zustand（本地编辑状态）+ TanStack Query（服务端数据） | |
| 拖拽 | dnd-kit | 策略组、规则排序 |
| 代码预览 | CodeMirror 6 | 移动端友好 |
| 国际化 | i18next | zh-CN、en |
| 加密 | Web Crypto（AES-GCM + HKDF） | Node 和 Workers 通用 |

### 命名约定

| 用途 | 名称 |
|---|---|
| GitHub 仓库 | `subloom` |
| npm 包（scope 形式） | `@subloom/core`、`@subloom/db`、`@subloom/server`；前端和入口应用设为 private，不发布 |
| Docker 镜像 | `ghcr.io/<owner>/subloom` |
| Worker 名称 | `subloom` |
| 环境变量前缀 | 无前缀（`ADMIN_TOKEN`、`SECRET_KEY` 等，部署时更易填写） |

### 硬性约束（写进 CLAUDE.md）

- `packages/core` 和 `packages/server` **禁止使用任何 Node 专有 API**（`Buffer`、`fs`、`path`、`crypto` 模块、`process` 等）。只能用 Web 标准 API：`fetch`、`TextEncoder`、`crypto.subtle`、`atob/btoa`、`URL`。
- **禁止 `eval` / `new Function`**（Workers 不支持）。
- Node 专有代码只能出现在 `apps/node`；Workers 专有代码只能出现在 `apps/worker`。
- core 中的每个导入器和导出器都必须有 golden 测试。

---

## 3. 仓库结构

```
.
├── PLAN.md                  本文件
├── CLAUDE.md                给 Claude Code 的约定（硬性约束、常用命令）
├── packages/
│   ├── core/                IR、导入器、导出器、节点处理流水线、能力矩阵（纯 TS）
│   │   ├── src/ir/          zod schema 与类型
│   │   ├── src/importers/   mihomo-yaml、uri（ss/vmess/vless/trojan/hy2...）、surge（后续）
│   │   ├── src/exporters/   mihomo、surge、shadowrocket、loon
│   │   ├── src/pipeline/    过滤、重命名、排序、去重、国旗等操作
│   │   ├── src/templates/   内置预设模板
│   │   └── test/fixtures/   输入样本与期望输出（golden）
│   ├── db/                  Drizzle schema + 迁移文件
│   └── server/              Hono 应用工厂 createApp(platform)，与运行时无关
├── apps/
│   ├── web/                 前端
│   ├── node/                Docker 入口：SQLite、文件缓存、定时器、托管静态前端
│   └── worker/              Workers 入口：D1、KV、Cron Triggers、托管静态前端
├── docker/                  Dockerfile、docker-compose.yml 示例
└── .github/workflows/       CI、Docker 发布、Workers 部署模板
```

---

## 4. 中间模型（IR）

位于 `packages/core/src/ir`，用 zod 定义，类型由 schema 推导。以下为骨架，实现时补全字段。

```ts
type Target = 'mihomo' | 'surge' | 'shadowrocket' | 'loon'

// ---- 节点 ----
type ProxyType =
  | 'ss' | 'ssr' | 'vmess' | 'vless' | 'trojan'
  | 'hysteria2' | 'tuic' | 'wireguard' | 'anytls'
  | 'http' | 'socks5'

interface ProxyBase {
  name: string
  type: ProxyType
  server: string
  port: number
  udp?: boolean
  tfo?: boolean
  tls?: TlsOptions          // sni、alpn、skipCertVerify、fingerprint、reality、ech 等
  transport?: Transport     // ws、grpc、h2、http、httpupgrade 等
  extra?: Record<string, unknown> // 无法映射的字段原样保留，导出时尽力输出
}
// 各协议用 discriminated union 扩展自己的字段（cipher、uuid、password、flow 等）

// ---- 策略组 ----
type BuiltinTarget = 'DIRECT' | 'REJECT' | 'REJECT-DROP'

interface ProxyGroup {
  name: string
  type: 'select' | 'url-test' | 'fallback' | 'load-balance'
  members: Array<
    | { kind: 'proxy'; name: string }
    | { kind: 'group'; name: string }
    | { kind: 'builtin'; name: BuiltinTarget }
  >
  includeAllProxies?: boolean   // 包含订阅中的全部节点
  filter?: { include?: string; exclude?: string } // 正则
  testUrl?: string
  interval?: number
  tolerance?: number
  hidden?: boolean
  icon?: string
}

// ---- 规则 ----
type RuleType =
  | 'DOMAIN' | 'DOMAIN-SUFFIX' | 'DOMAIN-KEYWORD' | 'DOMAIN-REGEX'
  | 'IP-CIDR' | 'IP-CIDR6' | 'GEOIP' | 'GEOSITE' | 'IP-ASN'
  | 'RULE-SET' | 'PROCESS-NAME' | 'DST-PORT' | 'SRC-IP-CIDR'
  | 'AND' | 'OR' | 'NOT' | 'MATCH'

interface Rule {
  type: RuleType
  value?: string            // MATCH 无 value；RULE-SET 的 value 为 ruleSet id
  children?: Rule[]         // AND / OR / NOT
  target: string            // 策略组名或 BuiltinTarget
  noResolve?: boolean
}

// ---- 规则集 ----
interface RuleSet {
  id: string
  name: string
  behavior: 'domain' | 'ipcidr' | 'classical'
  // 各客户端对应的远程地址与格式（社区规则仓库通常按客户端分目录提供）
  sources: Partial<Record<Target, { url: string; format: 'yaml' | 'text' | 'mrs' | 'list' }>>
  interval?: number
}

// ---- 顶层 ----
interface Profile {
  version: 1
  name: string
  general?: GeneralConfig   // 端口、日志、ipv6、测速地址等
  dns?: DnsConfig
  proxies: Proxy[]          // 手动添加的节点
  groups: ProxyGroup[]
  rules: Rule[]             // 有序
  ruleSets: RuleSet[]
}
```

### 导出器接口与能力矩阵

```ts
interface Capabilities {
  proxyTypes: ProxyType[]
  groupTypes: ProxyGroup['type'][]
  ruleTypes: RuleType[]
  logicalRules: boolean
  ruleSetFormats: string[]
  // 按需扩展
}

interface CompatWarning {
  level: 'info' | 'warn' | 'error'
  path: string              // 如 groups[2].type、proxies[5]
  code: string              // 如 UNSUPPORTED_PROXY_TYPE，前端据此做多语言
  message: string
  action: 'dropped' | 'downgraded' | 'kept'
}

interface Exporter {
  target: Target
  capabilities: Capabilities
  export(profile: Profile, nodes: Proxy[], opts: ExportOptions): { text: string; warnings: CompatWarning[] }
}
```

- 协议字段到各客户端的映射用**表驱动**写法，不要散落在 if-else 里。
- 降级规则示例：目标不支持 `load-balance` 时降级为 `url-test` 并警告；不支持的节点类型直接移除并警告；引用了被移除的组或节点的地方同步清理。

### 节点处理流水线

流水线以 JSON 数组的形式保存在 profile 上，每个操作都是纯数据，不含代码：

```ts
type PipelineOp =
  | { op: 'filter-regex'; pattern: string; mode: 'keep' | 'drop' }
  | { op: 'filter-type'; types: ProxyType[]; mode: 'keep' | 'drop' }
  | { op: 'filter-region'; regions: string[]; mode: 'keep' | 'drop' }
  | { op: 'rename-regex'; pattern: string; replace: string }
  | { op: 'add-flag' }
  | { op: 'sort'; by: 'name' | 'region'; order: 'asc' | 'desc' }
  | { op: 'dedupe'; by: 'name' | 'server' }
  | { op: 'prefix' | 'suffix'; text: string }
```

---

## 5. 后端设计

### 5.1 Platform 接口

`packages/server` 导出 `createApp(platform: Platform): Hono`。两个入口各自实现 Platform。

```ts
interface Platform {
  db: DrizzleSqliteDb             // better-sqlite3 或 D1
  blobs: BlobStore                // Node: 文件系统或 SQLite 表；Workers: KV
  env: { adminToken?: string; secretKey?: string; corsOrigins: string[]; allowPrivateFetch: boolean }
  waitUntil(p: Promise<unknown>): void // Node 下直接执行不等待；Workers 用 ctx.waitUntil
  isPrivateAddress?(host: string): Promise<boolean> // 仅 Node 实现 DNS 解析检查
}

interface BlobStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { ttlSec?: number }): Promise<void>
  delete(key: string): Promise<void>
}
```

定时任务：server 导出 `runScheduledRefresh(platform)`。Node 用 `setInterval` 调用，Workers 在 `scheduled` 事件中调用。

### 5.2 数据表（`packages/db`）

```
settings     key, value                               管理令牌哈希、实例配置等
sources      id, name, kind('remote'|'local'),
             url_enc, content, user_agent, ttl_sec,
             last_fetched_at, last_status, last_error,
             userinfo_json, created_at, updated_at
profiles     id, name, ir_json, pipeline_json,
             source_ids_json, updated_at, created_at
outputs      id, profile_id, target('mihomo'|'surge'|'shadowrocket'|'loon'|'auto'),
             token, options_json, last_access_at, created_at
fetch_logs   id, source_id, at, status, bytes, duration_ms, error
```

- 订阅原始内容、解析后的节点、生成好的配置**不存数据库**，存 BlobStore（D1 有单行大小限制）。
- Key 约定：`src:<id>:raw`、`src:<id>:nodes`、`out:<id>:<hash>`。

### 5.3 API

管理接口（`Authorization: Bearer <ADMIN_TOKEN>`）：

```
GET    /api/meta                     版本、运行平台、各导出器能力矩阵
GET    /api/sources                  列表
POST   /api/sources                  新建
GET    /api/sources/:id
PATCH  /api/sources/:id
DELETE /api/sources/:id
POST   /api/sources/:id/refresh      立即拉取
GET    /api/sources/:id/nodes        预览解析出的节点

GET    /api/profiles
POST   /api/profiles
GET    /api/profiles/:id
PATCH  /api/profiles/:id
DELETE /api/profiles/:id
POST   /api/profiles/:id/preview?target=surge   返回 { text, warnings }

GET    /api/outputs
POST   /api/outputs
DELETE /api/outputs/:id
POST   /api/outputs/:id/rotate       重新生成 token

GET    /api/backup                   导出全部数据（订阅 URL 明文，提示用户妥善保存）
POST   /api/restore
GET    /healthz
```

公开接口（无需认证，靠 token）：

```
GET /sub/:token
```

行为：

1. 根据 token 找到 output。target 为 `auto` 时按 User-Agent 识别客户端（识别失败默认 mihomo）。
2. 优先返回缓存的生成结果；缓存过期则先返回旧结果，同时用 `waitUntil` 在后台刷新（stale-while-revalidate）。没有缓存时才同步生成。
3. 响应头：
   - `Content-Type: text/plain; charset=utf-8`
   - `subscription-userinfo`：合并所有来源订阅的流量与到期时间（upload/download/total 求和，expire 取最早）
   - `profile-update-interval`：以小时为单位（mihomo 系客户端读取）
   - `Content-Disposition: attachment; filename*=UTF-8''<profile名>.yaml`（mihomo 系客户端用作配置名）
4. Surge 输出在首行写入 `#!MANAGED-CONFIG <当前URL> interval=<秒> strict=false`。
5. 更新 `last_access_at`。

### 5.4 订阅拉取

- 每个订阅可自定义 User-Agent（默认用 mihomo 风格的 UA，让机场返回 YAML）。
- 自动识别返回内容：mihomo YAML、Base64 编码的 URI 列表、纯文本 URI 列表。
- 解析上游响应头里的 `subscription-userinfo` 并保存。
- 拉取失败时**保留上一次成功的缓存**，记录错误，界面上展示。
- 超时 15 秒，响应体上限 10 MB。

### 5.5 安全

- **管理令牌**：优先读环境变量 `ADMIN_TOKEN`；未设置时首次启动自动生成，哈希后存入 settings，明文只打印一次到日志（Docker 日志 / Workers 控制台日志）。比较时用常量时间比较。
- **加密**：订阅 URL 使用 AES-GCM 加密存储，密钥由 `SECRET_KEY` 经 HKDF 派生。未设置 `SECRET_KEY` 时同样自动生成并持久化，同时在日志和文档里提醒用户备份（丢失则无法解密）。
- **输出 token**：32 字节随机数，base64url 编码。
- **SSRF**：默认拒绝拉取私有和保留地址（127/8、10/8、172.16/12、192.168/16、169.254/16、::1、fc00::/7 等），Node 下解析 DNS 后再检查一次。设置 `ALLOW_PRIVATE_FETCH=true` 可关闭（用于拉取局域网内的订阅）。
- **日志脱敏**：日志中不出现完整订阅 URL、节点地址和密码。
- **CORS**：管理接口只允许 `CORS_ORIGINS` 中列出的来源（默认包含实例自身和官方前端域名）。

### 5.6 Workers 的限制与对策

| 限制 | 对策 |
|---|---|
| 免费版单次请求 CPU 时间很短（约 10ms） | 生成结果缓存 + stale-while-revalidate；M2 里做性能基准测试（500 个节点），超限时在文档中说明可升级付费计划或改用 Docker |
| 不支持 eval | 自定义脚本功能仅 Docker 提供，前端根据 `/api/meta` 的平台信息隐藏 |
| 出口 IP 属于 Cloudflare，部分机场会拦截 | 文档说明，建议此类用户使用 Docker |
| D1 有单行大小限制 | 大内容放 KV |

---

## 6. 部署

### Docker

- 多阶段构建，产出单一镜像，内含 server 和前端静态文件。
- 多架构：`linux/amd64`、`linux/arm64`（覆盖 NAS 和树莓派）。
- 发布到 GHCR，镜像名 `ghcr.io/<owner>/subloom`（可选同时发布到 Docker Hub）。
- 数据目录 `/data`（SQLite 数据库 + 缓存文件），通过 volume 挂载。
- 环境变量：`ADMIN_TOKEN`、`SECRET_KEY`、`PORT`（默认 3000）、`CORS_ORIGINS`、`ALLOW_PRIVATE_FETCH`、`REFRESH_INTERVAL_MIN`。全部可选。
- 启动时自动执行数据库迁移。
- 提供 `HEALTHCHECK` 和 `docker-compose.yml` 示例。

### Cloudflare Workers

- `apps/worker/wrangler.jsonc` 声明 D1、KV 绑定，Cron Triggers，以及静态资源（Workers Static Assets 托管前端）。
- README 中放 "Deploy to Cloudflare" 按钮，目标是让用户全程不用命令行完成部署。实现时确认该按钮对 D1/KV 的自动创建和绑定支持情况，不支持的部分在文档中补充手动步骤。
- 首次请求时自动执行 D1 迁移（或在部署流程中执行），保证用户升级时零操作。
- 升级方式：用户 fork 仓库，通过 GitHub Actions 定期同步上游并自动部署。提供该 workflow 模板。

### 官方前端

- 部署在 Cloudflare Pages，纯静态，不存任何数据。
- 用户输入自己的后端地址和管理令牌后连接使用。

---

## 7. 前端（v0.1 范围）

页面：

1. **连接页**：输入后端地址和管理令牌（自带前端时后端地址自动填当前域名）。令牌存在 localStorage。
2. **订阅源**：列表、新增/编辑、立即刷新、查看节点、查看最近一次拉取状态和错误、流量与到期信息。
3. **配置编辑器**（核心页面）：
   - 选择来源订阅；从预设模板新建。
   - 策略组：树形视图展示嵌套关系，拖拽排序，编辑类型和成员，按正则筛选节点。
   - 规则：列表，拖拽排序，快速添加；规则集从内置的常用规则源中选择。
   - 右侧（移动端为切换标签）实时预览：选择目标客户端，显示生成的配置文本和兼容性警告。
4. **输出链接**：为配置创建输出（选择客户端），复制链接、显示二维码、重新生成 token。

要求：响应式布局，手机上可用；中英文；深色模式。

---

## 8. 测试与 CI

- **core**：每个导入器和导出器都有 golden 测试（`test/fixtures/<case>/input.*` 与 `expected.<target>.*`）。更新快照必须是有意为之。
- **mihomo 实际校验**：CI 下载 mihomo 二进制，对所有 mihomo golden 输出执行 `mihomo -t`。注意 GEOIP/GEOSITE 规则可能需要提前准备数据文件。
- **server**：同一套 API 集成测试分别在 Node（better-sqlite3）和 Workers（vitest-pool-workers + D1/KV 模拟）下运行。
- **性能基准**：500 节点订阅 → 解析 → 流水线 → 导出，记录耗时，在 CI 中监控回退。
- **CI 流程**：lint → typecheck → test → build；main 分支打 tag 时发布 Docker 镜像。

---

## 9. 里程碑

每个里程碑大致对应 Claude Code 的一到几次会话。完成后在此处勾选。

### M0 仓库脚手架
- [ ] pnpm workspaces + Turborepo，TypeScript strict 基础配置，Biome，Vitest
- [ ] 创建 3 节中的所有包和应用的空壳，包名按"命名约定"使用 `@subloom/*`
- [ ] CLAUDE.md（硬性约束、常用命令）
- [ ] GitHub Actions：lint、typecheck、test、build
- **验收**：`pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部通过

### M1 core：IR 与 mihomo
- [ ] IR zod schema（第 4 节）
- [ ] 导入器：mihomo YAML；URI（ss、vmess、vless 含 reality、trojan、hysteria2）；Base64 订阅自动识别
- [ ] mihomo 导出器（含 rule-providers、proxy-providers 风格的规则集输出）
- [ ] 流水线操作（第 4 节全部）
- [ ] 预设模板 2 套（极简、常用分流）
- [ ] golden 测试，CI 中执行 `mihomo -t`
- **验收**：样例订阅导入后经流水线处理，导出的配置能通过 `mihomo -t`

### M2 core：Surge 与兼容性警告
- [ ] Surge 导出器（节点、策略组、规则、RULE-SET、General、DNS 基础项）
- [ ] 能力矩阵与 CompatWarning 机制，降级逻辑和引用清理
- [ ] 性能基准测试（500 节点）
- **验收**：同一份 profile 导出 mihomo 和 Surge 均正确；含不支持功能时警告完整准确

### M3 server：存储与订阅源
- [ ] `packages/db` schema 与迁移
- [ ] Platform 与 BlobStore 接口，`createApp(platform)`
- [ ] 管理令牌（自动生成逻辑）、加密模块、SSRF 检查
- [ ] sources 增删改查、拉取（UA、格式识别、userinfo、失败保留缓存）、拉取日志
- [ ] `apps/node` 入口：better-sqlite3、文件 BlobStore、定时刷新
- **验收**：Node 下可通过 API 添加订阅并刷新，节点预览正确，数据库中 URL 为密文

### M4 server：配置与输出链接
- [ ] profiles 增删改查、preview 接口
- [ ] outputs 增删改查、rotate
- [ ] `/sub/:token`：UA 识别、缓存与 stale-while-revalidate、全部响应头、Surge MANAGED-CONFIG
- [ ] backup / restore、`/api/meta`、`/healthz`
- **验收**：mihomo 客户端和 Surge 能通过输出链接导入配置，并显示流量信息

### M5 Workers 入口
- [ ] `apps/worker`：D1、KV BlobStore、Cron Triggers、waitUntil
- [ ] wrangler 配置、静态资源托管、自动迁移
- [ ] API 集成测试在 Workers 环境下全部通过
- [ ] Deploy 按钮与部署文档
- **验收**：Fork 后可一键部署到 Cloudflare，功能与 Node 版一致

### M6 Docker
- [ ] 多阶段 Dockerfile、多架构构建、发布到 GHCR
- [ ] 内置前端静态文件、HEALTHCHECK、docker-compose 示例
- **验收**：`docker compose up -d` 后即可使用，重启后数据保留

### M7 前端 v0.1
- [ ] 第 7 节全部页面
- [ ] i18n（中、英），深色模式，移动端适配
- **验收**：完整走通"连接后端 → 添加订阅 → 从模板建配置 → 编辑策略组和规则 → 预览 → 生成链接 → 客户端导入"

### M8 文档与发布 v0.1.0
- [ ] README（中、英）：功能介绍、Docker 部署、Workers 部署、升级、常见问题
- [ ] 免责声明：不提供节点，不运营公共服务
- [ ] LICENSE、CONTRIBUTING（重点：如何新增一个客户端导出器）、issue 模板（要求附脱敏配置）
- [ ] 打 tag 发布 v0.1.0

---

## 10. 后续规划（v0.2 以后）

- Shadowrocket、Loon 导出器
- 流水线可视化编排界面
- 多订阅合并的界面支持
- 规则集市场：内置常用社区规则源，按客户端自动匹配 URL 和格式
- 反解析导入 Surge 配置
- 高级设置：DNS 细项、TUN、嗅探
- 自定义脚本（仅 Docker）
- 备份到 Gist / WebDAV
- sing-box、Quantumult X 导出器
- 本地纯前端模式
- core 打包为可在 Surge/Loon 脚本环境中运行的版本

---

## 11. 待决定事项

- [x] 项目名称：SubLoom
- [ ] 确认 GitHub 组织/用户名、npm 组织 `subloom` 可注册
- [ ] 官方前端域名（如 subloom.app / subloom.dev）
- [ ] 许可证：AGPL-3.0（防止闭源商用）或 MIT（传播更广）
- [ ] 预设模板默认引用哪些社区规则仓库（引用 URL 即可，不复制内容）

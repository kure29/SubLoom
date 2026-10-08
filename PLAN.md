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
| YAML | 解析：`js-yaml`；生成：自写的字符串生成器 | 导入/导出是生成配置的热路径，通用 `yaml` 库在 500 节点时解析约 70ms、生成约 40ms（见 5.6）。需要保留注释的场景（如以后反解析、编辑用户的原始配置）再用 `yaml` 库；目前 `yaml` 只用于测试 |
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

// 无法映射的字段按来源格式分命名空间原样保留，导出时尽力输出（见下方"IR 约定"）
type Extra = Partial<Record<'mihomo' | 'uri' | 'surge', Record<string, unknown>>>

interface ProxyBase {
  name: string
  type: ProxyType
  server: string
  port: number
  udp?: boolean
  tfo?: boolean
  tls?: TlsOptions          // 存在即启用 TLS：sni、alpn、skipCertVerify、clientFingerprint、reality、ech 等
  transport?: Transport     // ws、grpc、h2、http、httpupgrade 等
  extra?: Extra
}
// 各协议用 discriminated union 扩展自己的字段（cipher、uuid、password、flow 等）
// hysteria2 支持端口跳跃：ports?: string（如 "20000-30000"），port 取范围内第一个端口

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
  extra?: Extra
}

// ---- 规则 ----
type RuleType =
  | 'DOMAIN' | 'DOMAIN-SUFFIX' | 'DOMAIN-KEYWORD' | 'DOMAIN-REGEX'
  | 'IP-CIDR' | 'IP-CIDR6' | 'GEOIP' | 'GEOSITE' | 'IP-ASN'
  | 'RULE-SET' | 'PROCESS-NAME' | 'DST-PORT' | 'SRC-IP-CIDR'
  | 'AND' | 'OR' | 'NOT' | 'MATCH'

interface RuleCondition {
  type: RuleType
  value?: string            // MATCH 无 value；RULE-SET 的 value 为 ruleSet id
  children?: RuleCondition[] // AND / OR / NOT 的子条件（子条件没有 target）
  noResolve?: boolean
  src?: boolean             // 按来源 IP 匹配（mihomo 的 src 参数），仅 IP-CIDR、IP-CIDR6、GEOIP、IP-ASN、RULE-SET
}

interface Rule extends RuleCondition {
  target: string            // 策略组名或 BuiltinTarget
}

// ---- 规则集 ----
interface RuleSet {
  id: string
  name: string
  behavior: 'domain' | 'ipcidr' | 'classical'
  // 各客户端对应的远程地址与格式（社区规则仓库通常按客户端分目录提供）
  sources: Partial<Record<Target, { url: string; format: 'yaml' | 'text' | 'mrs' | 'list' }>>
  interval?: number
  extra?: Extra
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
  extra?: Extra             // GeneralConfig、DnsConfig 也带 extra
}
```

### IR 约定

- 字段名统一 camelCase，与来源格式无关。节点的 TS 类型名为 `ProxyNode`（避免遮蔽全局 `Proxy`），schema 为 `ProxySchema`。
- **规范形式**：默认值为 false 的可选布尔字段（`tfo`、`skipCertVerify`、`hidden`、`noResolve`、`src` 等），值为 false 时省略，由导入器负责规范化。来源无法表达的信息不编造。
- 默认值不是 false 的布尔字段不省略 false：如 GeneralConfig 的 `ipv6`（mihomo 默认开启）。
- **`udp` 是三态**，不按上一条省略 false：`true` / `false` 表示来源明确给出的值，未设置表示来源无法表达（如 URI 链接），导出时按导出选项 `defaultUdp` 处理。mihomo YAML 能表达 UDP，未写 `udp` 时按 mihomo 的默认值记录：hysteria2、tuic 为 `true`（mihomo 对这两种协议总是开启 UDP），其余为 `false`。
- **规则参数**：mihomo 的 `no-resolve`、`src` 参数分别映射为 `noResolve`、`src`（子条件同样适用）。`src` 只允许出现在 mihomo 支持它的规则类型上，丢弃它会把"按来源 IP 匹配"变成"按目标 IP 匹配"，因此必须保留；其余参数丢弃并给出 `UNSUPPORTED_RULE_PARAM` 警告。
- **extra 按来源格式分命名空间**：如 `extra: { mihomo: { 'ip-version': 'ipv4' } }`、`extra: { uri: { pinSHA256: '...' } }`，键名和嵌套结构保持来源原样（mihomo 子对象中剩余的键放在同名子对象下，如 `{ 'ws-opts': { ... } }`）。导出器只合并与自己格式相同的那份，其余给出警告。
- `tls`、`transport` 只出现在适用的协议上（如 ss 没有 `transport`），不放在公共字段里。`tls` 存在即启用 TLS；trojan、hysteria2、tuic、anytls 的 `tls` 始终存在（可为 `{}`）。uTLS 指纹为 `tls.clientFingerprint`，证书指纹为 `tls.certFingerprint`。

### 导入器

- `importSubscription(text)` 自动识别格式，依次尝试：mihomo YAML（顶层有 `proxies`、`proxy-groups`、`rules` 或 `rule-providers`）→ 明文链接列表（某行以 `scheme://` 开头）→ Base64（标准 / URL-safe、有无 padding、允许换行）编码的链接列表。都不是时返回 `UNKNOWN_FORMAT` 错误。
- 返回 `{ format, proxies, config?, warnings }`，`config` 仅在 YAML 包含策略组、规则等内容时存在。
- 保持源顺序，不去重（去重交给流水线）。
- 非法或不支持的条目跳过并产生警告：URI 带行号和协议名，YAML 带路径（如 `rules[12]`）。警告中不包含原始链接内容（可能含密码）。
- IR 无法表示的整条对象（如不在 RuleType 中的规则、非 http 的 rule-provider）跳过并警告。

### 导出器接口与能力矩阵

```ts
interface Capabilities {
  proxyTypes: ProxyType[]
  groupTypes: ProxyGroup['type'][]
  ruleTypes: RuleType[]
  logicalRules: boolean
  ruleSetFormats: string[]
  ruleSetProxy: boolean     // 能否指定通过某个策略组下载规则集
  // 按需扩展
}

interface CompatWarning {
  level: 'info' | 'warn' | 'error'
  path: string              // 如 groups[2].type、proxies[5]、nodes[3]（订阅节点）、options.ruleSetPolicy
  code: string              // 如 UNSUPPORTED_PROXY_TYPE，前端据此做多语言
  message: string
  action: 'dropped' | 'downgraded' | 'kept'
}

interface ExportOptions {
  defaultUdp?: boolean      // 节点未设置 udp 时是否开启 UDP，默认 true
  ruleSetPolicy?: string    // 规则集下载策略组：策略组名或 DIRECT，默认见下方"规则集下载"
  ruleSetMirror?: 'original' | 'jsdelivr' | { prefix: string } // 规则集镜像，默认 original
  proxyProvider?: { name: string; url: string; interval?: number } // 仅 mihomo：订阅节点改由 proxy-providers 引用，见"mihomo 导出器"
}

interface Exporter {
  target: Target
  capabilities: Capabilities
  export(profile: Profile, nodes: ProxyNode[], opts?: ExportOptions): { text: string; warnings: CompatWarning[] }
}
```

- `nodes` 是经过流水线处理的订阅节点。输出的节点列表为 `profile.proxies` 在前、`nodes` 在后。
- 协议字段到各客户端的映射用**表驱动**写法，不要散落在 if-else 里。导入器和导出器共用同一张字段表。
- **共用的导出前处理**（`exporters/resolve.ts` 的 `resolveProfile`）：降级、名称冲突、引用清理与客户端无关，所有导出器先调用它，再把结果写成自己的格式，保证行为一致。客户端只提供能力矩阵、内置策略名、规则集来源选择，以及可选的节点子功能检查和规则参数检查。处理顺序（也是警告的顺序）：组去重 → 节点（类型、子功能）→ 节点改名 → 组（类型降级、成员）→ 规则集（来源、镜像）→ 规则集下载策略 → 规则。
- **降级规则**：
  - 不支持的节点类型：移除并警告（`UNSUPPORTED_PROXY_TYPE`）。被移除的节点不占用名称。
  - 节点类型受支持、但用到了不支持的子功能：影响连通性的（传输层、插件、reality、obfs 等）移除整个节点；不影响连通性的可选项（如 uTLS 指纹）只去掉该字段，节点保留。两种情况都给出 `UNSUPPORTED_PROXY_FEATURE` 警告，path 指向具体字段（如 `nodes[3].tls.clientFingerprint`）。每个客户端的字段归类写在该导出器的能力矩阵旁边。
  - 不支持的组类型：`load-balance`、`fallback` 降级为 `url-test`，`url-test` 降级为 `select`（`UNSUPPORTED_GROUP_TYPE`，path 为 `groups[i].type`）。
  - 不支持的规则类型（含逻辑规则中的子条件）、不支持逻辑规则时的 AND/OR/NOT：移除整条规则（`UNSUPPORTED_RULE_TYPE`）。客户端无法表达的规则参数（如 `src`）同样移除整条规则（`UNSUPPORTED_RULE_PARAM`），不丢弃参数后保留规则。
  - 引用了被移除的组或节点的地方按下面的"悬空引用"规则同步清理。
- **名称冲突**：节点重名（含与策略组名、内置目标重名）时，后出现的节点自动改名为 `名称 2`、`名称 3`……并警告；策略组成员和规则中引用该名称的地方指向第一个同名节点。策略组重名时保留第一个，其余移除并警告。
- **悬空引用**：策略组中找不到（不存在或已被移除）的节点或组成员移除并警告；移除后没有任何成员（且没有 `includeAllProxies` 等自动包含方式）的组补上 `DIRECT` 并警告；目标不存在的规则、引用了不存在或不可用规则集的规则移除并警告。规则集 `id` 重复时保留第一个，其余移除并警告。
- **extra**：只合并与目标格式同名的命名空间（深度合并，IR 字段优先），其余命名空间丢弃并给出 `EXTRA_IGNORED` 警告。

### 规则集下载

- **下载策略组**（导出选项 `ruleSetPolicy`）：指定通过哪个策略组下载规则集，值为策略组名或 `DIRECT`。未设置时使用 profile 中第一个 `select` 组（预设模板中即"节点选择"），没有 `select` 组时为 `DIRECT`。只能选策略组或 `DIRECT`，不能选单个节点或其他内置策略。
- 指定的策略组不存在（被删除或改名）时按引用清理规则回退到 `DIRECT`，并给出 `UNKNOWN_RULE_SET_POLICY` 警告（path 为 `options.ruleSetPolicy`）。
- 客户端是否支持"通过代理下载规则集"是能力矩阵中的一项（`ruleSetProxy`），以各客户端官方文档为准。不支持且下载策略不是 `DIRECT` 时给出 `RULE_SET_PROXY_UNSUPPORTED` 警告，提示改用镜像地址；已经设置了镜像时降为 info。
- 没有导出任何规则集时不检查此选项，也不产生警告。
- **规则集镜像**（导出选项 `ruleSetMirror`）：作为不支持代理下载时的备选，对所有客户端生效。
  - `original`（默认）：原始地址。
  - `jsdelivr`：把 `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`（含 `refs/heads/`、`refs/tags/` 形式）和 `github.com/<owner>/<repo>/raw/<ref>/<path>` 改写为 `cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>`；其他地址保持原样并给出 info 级的 `RULE_SET_MIRROR_UNSUPPORTED`。
  - `{ prefix }`：在原始地址前直接拼接自定义前缀（如 `https://mirror.example.com/` + 原始地址）。

### mihomo 导出器

- 输出顺序：general 字段 → 顶层 extra → `dns` → `proxies` → `proxy-groups` → `rule-providers` → `rules`。
- 规则集输出为 `rule-providers`（`type: http`，键为 RuleSet 的 `id`）+ `RULE-SET,<id>,<target>` 规则。没有 `sources.mihomo`、格式为 `list`、或 `classical` 行为配 `mrs` 格式的规则集无法使用，移除并警告。
- rule-provider 总是输出 `proxy` 字段（下载策略，见"规则集下载"，包括 `DIRECT`）。导入时保留在 `extra.mihomo.proxy` 中的值被导出选项覆盖，两者不同时给出 info 级的 `EXTRA_IGNORED`。
- mihomo 的规则是逗号分隔、不能加引号的字符串：节点名和组名中的 `,` 替换为全角 `，`（与 Surge 相同，`INVALID_NAME_CHARS`），值中含逗号的规则移除并警告（`UNSUPPORTED_RULE_VALUE`）。
- 节点默认直接写入 `proxies`。
- **proxy-providers**（导出选项 `proxyProvider`，由 server 根据输出链接生成，见 5.3 的输出选项 `nodes: 'provider'`）：订阅节点不写入 `proxies`，改为 `proxy-providers: { <name>: { type: http, url, interval } }`（位于 `proxies` 之后、`proxy-groups` 之前；与 `profile.extra.mihomo['proxy-providers']` 合并，同名时以导出选项为准）。`includeAllProxies` 的组在 `include-all-proxies` 之外加 `use: [<name>]`（`filter`、`exclude-filter` 同样作用于 provider 中的节点）。mihomo 组的 `proxies` 不能引用 provider 中的节点：显式引用订阅节点的成员按悬空引用移除并警告（`UNKNOWN_GROUP_MEMBER`）。设置该选项时导出器忽略传入的 `nodes`。其他导出器忽略该选项。
- YAML 用自写的字符串生成器输出（风格与 `yaml` 库 `lineWidth: 0` 相同，测试中与原实现逐字节对照），不折行；按 YAML 1.1 规则给可能被误读的字符串（如 `01234567`、`yes`、`1_000`）加引号，保证 mihomo（go-yaml）读到的仍是字符串。换行、控制字符写成单行双引号字符串。

### Surge 导出器

能力以 [Surge 官方手册](https://manual.nssurge.com/)为准，能力矩阵的代码注释中注明出处页面。Surge 没有命令行校验工具，golden 快照逐个人工核对。

已在 Surge iOS 上实测（PR #4）：不加方括号的 IPv6 服务器地址、以 `[` 开头的节点名、`salamander-password`、引号内的 `\\` 与 `\"` 转义均可正常导入；HTTPS 的 `proxy-test-url` 在该版本上报错，因此改写为 HTTP（见下）。

- **输出结构**：`[General]` → `[Proxy]` → `[Proxy Group]` → `[Rule]` → `[WireGuard <名称>]` 段 → `profile.extra.surge` 中的附加段。`#!MANAGED-CONFIG` 首行由 M4 的 `/sub/:token` 添加。
- **名称**：Surge 的策略名不能加引号，出现在 `名称 = …`、逗号分隔的组成员和规则中。节点名和组名中的 `,`、`=` 替换为全角的 `，`、`＝`；空白后的行内注释符（` #`、` //`、` ;`）中的 `#`、`/`、`;` 替换为全角字符。替换在名称冲突处理之前进行（`resolveProfile` 的 `sanitizeName`），引用同步更新，给出 `INVALID_NAME_CHARS`（kept）。
- **参数值**：含逗号、引号、首尾空白或行内注释符的值用双引号包裹，`"` 和 `\` 转义为 `\"`、`\\`。
- **节点**（`[Proxy]`，`名称 = 类型, 服务器, 端口, 参数=值, …`）：
  - 支持 ss、vmess、trojan、hysteria2、tuic（输出为 `tuic-v5`）、wireguard、anytls、http（有 TLS 时为 `https`）、socks5（有 TLS 时为 `socks5-tls`）；ssr、vless 不支持。
  - ss：`encrypt-method` 必须在手册列出的加密方式中，否则移除节点；obfs 插件映射为 `obfs`、`obfs-host`；v2ray-plugin 移除节点。
  - vmess：`username` = uuid；`alterId` 为 0 时 `vmess-aead=true`；加密方式 `auto`/`aes-128-gcm` 用 Surge 默认值，`chacha20-poly1305` 映射为 `chacha20-ietf-poly1305`，其余（VMess 的加密方式由客户端决定，服务端都接受）改用默认值并警告（downgraded）。
  - 传输层（vmess、trojan）：只支持 ws（`ws=true`、`ws-path`、`ws-headers=Host:…|K:V`），early data 字段去掉并警告；其他传输层、或请求头中含 `|` 时移除节点。
  - hysteria2：`ports` → `port-hopping`（分隔符改为 `;`）；`down` → `download-bandwidth`（Mbps）；`up` 去掉并警告；salamander → `salamander-password`（手册只标了 Mac 6.4.3+，已在 iOS 上实测可用，不再警告）。没有密码时移除节点。
  - tuic：`uuid`、`password`；`congestionController`、`udpRelayMode`、`reduceRtt` 没有对应参数，去掉并警告。
  - wireguard：`名称 = wireguard, section-name=<段名>` 加 `[WireGuard <段名>]` 段（段名为 `wg1`、`wg2`……）。`allowed-ips` 按 mihomo 默认值生成（有 `ip` 时 `0.0.0.0/0`，有 `ipv6` 时 `::/0`）；`reserved` → `client-id`。Surge 中没有 `dns-server` 的 WireGuard 策略不能解析目标域名，因此 `dns-server` 取 `extra.mihomo.dns` 中的 IP 地址，没有时移除节点。
  - TLS：`sni`、`alpn`、`skip-cert-verify`；证书指纹 → `server-cert-fingerprint-sha256`（64 位十六进制，可带冒号），格式不符时移除节点；reality 移除节点；uTLS 指纹、ECH 去掉并警告。
  - UDP：ss、socks5 按 `udp ?? defaultUdp` 输出 `udp-relay=true`；vmess、trojan、hysteria2、tuic、anytls、wireguard 总是支持 UDP，没有对应开关；http 不支持 UDP。`tfo` → `tfo=true`。
  - `extra.surge` 作为额外参数追加在行尾（IR 字段优先）。
- **策略组**（`[Proxy Group]`）：四种类型都支持。`includeAllProxies` → `include-all-proxies=true`；`filter` → `policy-regex-filter`，Surge 没有排除过滤，有 `exclude` 时合并为 `^(?=.*(?:include))(?!.*(?:exclude))` 并给 info（`(?i)` 开头的写成 `(?i:…)`）。`interval` 只用于 url-test、fallback、load-balance，`tolerance` 只用于 url-test，其他组上的去掉并警告。`hidden` → `hidden=true`，`icon` → `icon-url`。
  - Surge 没有组级测速地址：所有组的 `testUrl` 相同时写入 `[General]` 的 `proxy-test-url`；不同时取第一个，其余组给出 downgraded 警告。`general.extra.surge` 中写了 `proxy-test-url`（键名不区分大小写）时以它为准。
  - **测速地址只用 HTTP**：HTTPS 测速地址需要 Surge iOS 5.23.0+ / Mac 6.10.0+（profile/general.md 的 `proxy-test-url`、policies/parameters.md 的 `test-url`），低版本会报"存在无效配置"（已在手机上复现）。导出时把 `proxy-test-url`、`internet-test-url` 和节点的 `test-url`（来自组的 `testUrl` 或 `extra.surge`）中的 `https://` 改为 `http://`，给 info 级的 `TEST_URL_REWRITTEN`（downgraded）。只影响 Surge，模板和 mihomo 不变。
- **规则**：`DST-PORT` → `DEST-PORT`，`SRC-IP-CIDR` → `SRC-IP`，`MATCH` → `FINAL`；`DOMAIN-REGEX`、`GEOSITE` 不支持。带 `src` 的 `IP-CIDR`、`IP-CIDR6` 转为 `SRC-IP`；`GEOIP`、`IP-ASN`、`RULE-SET` 带 `src` 时无法表达，移除整条规则。`no-resolve` 只写在 IP 类规则和规则集上。含逗号的值加引号。
  - Surge 要求规则以 `FINAL` 结尾，且多个 `FINAL` 时最后一个生效：导出到第一条 `MATCH` 为止，其后的规则移除并给 info（`UNREACHABLE_RULE`）；没有 `MATCH` 时补 `FINAL,DIRECT` 并警告（`MISSING_FINAL_RULE`）。
- **规则集**：`sources.surge` 的格式为 `list` 时输出 `RULE-SET,<url>,<策略>`（规则列表，任意 behavior）；格式为 `text` 且 behavior 为 `domain` 时输出 `DOMAIN-SET,<url>,<策略>`；其余不可用并警告。`interval` → `update-interval`。Surge 的 RULE-SET 没有指定下载策略的参数，能力矩阵中 `ruleSetProxy: false`。
- **General / DNS**：`logLevel` → `loglevel`（debug → verbose、info → info、warning 和 error → warning、silent → warning 并警告）；`ipv6` → `ipv6`（未设置时取 `dns.ipv6`）。`dns.nameserver` 中的 IP 地址、`udp://`、`tcp://` 和 `system`，以及 `defaultNameserver` → `dns-server`；`https://`、`tls://`、`quic://`、`h3://` → `encrypted-dns-server`；其他写法（主机名、`dhcp://`、带 `#` 参数的）去掉并警告（`UNSUPPORTED_DNS_SERVER`）。端口、`allowLan`、`bindAddress`、`mode` 以及 DNS 的 `enable`、`listen`、`enhancedMode`、`fakeIpRange`、`fallback` 在 Surge 中没有对应项或与平台有关，去掉并警告（`UNSUPPORTED_SETTING`）。`general.extra.surge`（及 `dns.extra.surge`）追加为 `[General]` 中的 `键 = 值`。Surge 的 General 键不区分大小写（profile/general.md），与已生成的键（`loglevel`、`ipv6`、`dns-server`、`encrypted-dns-server`）或彼此同名（忽略大小写）的键只保留一个：生成的键优先，重复的 extra 键去掉并给出 `EXTRA_IGNORED`；`proxy-test-url` 例外，见上。
- **profile.extra.surge**：`{ 段名: 行[] }`，作为附加段原样输出（如 `MITM`、`Host`）；与生成的段同名或格式不对时忽略并警告。

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
  | { op: 'force-udp'; pattern?: string; types?: ProxyType[] }
```

- `runPipeline(nodes, ops)` 是纯函数，按顺序执行，返回 `{ nodes, warnings }`。它只处理订阅节点，手动添加的节点（`profile.proxies`）不经过流水线。
- **正则**：JavaScript RegExp 语法（以 `u` 标志编译，便于匹配国旗等 emoji），只匹配节点名称；为与 mihomo 策略组的 `filter` 写法兼容，允许以 `(?i)` 开头表示忽略大小写。`rename-regex` 全局替换，替换串支持 `$1` 等。正则非法时跳过该操作并警告，不中断流水线。
- **地区**：`regions` 使用 ISO 3166-1 alpha-2 代码（如 `HK`、`JP`、`US`）。地区由节点名识别：优先看国旗 emoji，其次按内置地区表匹配中英文名称、常见城市和代码（ASCII 代码按单词边界、区分大小写匹配，避免 `US` 误中 `RUSSIA`）。识别不出地区的节点：`filter-region` 的 keep 模式丢弃、drop 模式保留。
- `add-flag`：在名称前加地区国旗和一个空格；名称已以国旗开头或识别不出地区时不变。
- `sort`：稳定排序。`name` 按 `Intl.Collator`（numeric）比较；`region` 按内置地区表的顺序（常见地区在前），识别不出地区的节点无论升降序都排在最后。
- `dedupe`：保留第一个。`name` 按名称；`server` 按 `type + server + port`。
- `force-udp`：把作用范围内节点的 `udp` 设为 `true`（覆盖来源给出的 `false`）。`pattern`（正则，规则同上）和 `types` 都不给时作用于全部节点；只给一个时按它筛选；都给时两者都要满足。预设模板不默认启用，由前端作为一个明显的开关提供。

### 预设模板

- `createTemplate(id, { locale })` 返回一个不含节点的 `Profile`，`id` 为 `minimal`（极简）或 `common`（常用分流），`locale` 为 `zh-CN` 或 `en`，只影响 profile 名称和策略组名称。
- 策略组用 `includeAllProxies` 包含订阅节点。
- **极简**：节点选择（select）、自动选择（url-test）；规则只有局域网直连（内联 IP-CIDR，no-resolve）、`GEOIP,CN` 直连和 `MATCH`。
- **常用分流**：在极简基础上增加 AI、YouTube、Google、Telegram、Microsoft 分组和漏网之鱼；规则集引用 [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script)（同名规则同时提供 Clash、Surge、Shadowrocket、Loon 格式），只引用 URL、不复制内容。只选用可单独使用的规则文件（如 `Lan.yaml`），不选需要与 `_Domain` 文件配合的拆分规则。

---

## 5. 后端设计

### 5.1 Platform 接口

`packages/server` 导出 `createApp(platform: Platform): Hono`。两个入口各自实现 Platform。

```ts
interface Platform {
  name: 'node' | 'workers'        // 运行平台，/api/meta 返回给前端
  db: SubloomDb                   // @subloom/db 导出的类型：better-sqlite3 或 D1 的 Drizzle 实例
  blobs: BlobStore                // Node: 文件系统；Workers: KV
  env: {
    adminToken?: string; secretKey?: string; corsOrigins: string[]; allowPrivateFetch: boolean
    publicUrl?: string              // PUBLIC_URL：设置后所有对外链接都用它生成，见 5.3"对外链接"
    trustProxy: boolean             // TRUST_PROXY：为 true 时才读取 X-Forwarded-* 头
  }
  waitUntil(p: Promise<unknown>): void // Node 下直接执行不等待；Workers 用 ctx.waitUntil
  resolveHost?(host: string): Promise<string[]> // 仅 Node 实现：DNS 解析出的全部地址，私有地址判断在 server 中统一完成
}

interface BlobStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { ttlSec?: number }): Promise<void>
  delete(key: string): Promise<void>
}
```

- **初始化**：server 导出 `bootstrap(platform)`（幂等，同一份数据库（`platform.db` 对象）与环境变量（`platform.env` 对象）只执行一次；Workers 每个请求的 `waitUntil` 不同，因此每个请求构造新的 platform，但复用同一个 `db` 和 `env` 对象，不会每个请求都重新初始化）：执行数据库迁移 → 准备管理令牌 → 准备加密密钥（见 5.5）。`createApp` 的中间件在每个请求前等待它完成，因此 Workers 在首次请求时自动初始化；Node 入口在启动时先调用一次，让自动生成的令牌在启动日志中打印出来。
- **环境变量解析**：server 导出 `parseEnv(vars)`，把字符串形式的环境变量（Node 的 `process.env`、Workers 的 `env` 中的 vars 和 secrets）解析为 `PlatformEnv`，两个入口共用，保证行为一致。空字符串视为未设置；布尔值只有 `true`、`1`、`yes`（不区分大小写）为真；`PUBLIC_URL` 必须是不带查询参数和片段的 http(s) URL，否则报错（Node 启动失败；Workers 请求返回 500 并在日志中说明）。
- 定时任务：server 导出 `runScheduledRefresh(platform)`，逐个刷新到期的远程订阅（`last_fetched_at + ttl_sec` 已过，从未拉取过的也算），串行执行。Node 用 `setInterval` 调用（间隔 `REFRESH_INTERVAL_MIN`，上一轮未结束时跳过），Workers 在 `scheduled` 事件中调用。

### 5.2 数据表（`packages/db`）

```
settings     key, value                               管理令牌哈希、实例配置等
sources      id, name, kind('remote'|'local'),
             url_enc, content, user_agent, ttl_sec,
             last_fetched_at, last_status, last_error,
             userinfo_json, nodes_fetched_at, created_at, updated_at
profiles     id, name, ir_json, pipeline_json,
             source_ids_json, updated_at, created_at
outputs      id, profile_id, target('mihomo'|'surge'|'shadowrocket'|'loon'|'auto'),
             token, options_json, last_access_at, created_at
fetch_logs   id, source_id, at, status, bytes, duration_ms, error
```

- 订阅原始内容、解析后的节点、生成好的配置**不存数据库**，存 BlobStore（D1 有单行大小限制）。本地订阅（`kind: 'local'`）由用户粘贴，内容存在 `content` 列。
- Key 约定：`src:<id>:raw`（远程订阅最近一次成功拉取的原始内容）、`src:<id>:nodes`、`out:<id>:<target>`（生成结果缓存，`target` 为 `mihomo`、`surge` 或节点列表 `proxies`，见 5.3"生成结果缓存"）。
- `sources.nodes_fetched_at`：`src:<id>:nodes` 的版本（即其中的 `fetchedAt`，从未成功时为 null），生成结果的缓存键用它判断节点是否变化，不必读取节点缓存本身。
- `profiles.name` 与 IR 中的 `name` 保持一致（列表不必解析 `ir_json`）；`source_ids_json` 为有序的订阅源 id 数组，删除订阅源时从所有 profile 中移除。
- **`src:<id>:nodes`**：刷新订阅时就把解析结果以 JSON 存入（`{ fetchedAt, format, proxies, warnings }`，即 `importSubscription` 的结果去掉 `config`，加上本次成功拉取的时间）。解析比导出更耗时（500 节点约 10ms，见 5.6），生成配置时直接读取它，不再重复解析原始内容。
- 时间字段（`*_at`）均为毫秒时间戳（整数）。`last_status`、`fetch_logs.status` 为 `'ok' | 'error'`，HTTP 状态码等细节写在 `error` 中。`last_fetched_at` 是最近一次尝试拉取的时间（无论成败），最近一次成功的时间见 nodes 中的 `fetchedAt`。
- `fetch_logs.source_id` 引用 `sources`、`outputs.profile_id` 引用 `profiles`，均为 `ON DELETE CASCADE`（Node 下需开启 `PRAGMA foreign_keys`，D1 默认开启）。每个订阅只保留最近 20 条拉取日志。
- **迁移**：schema 用 Drizzle 定义（`src/schema.ts`），`drizzle-kit generate` 生成 SQL 到 `packages/db/migrations/`，再由 `scripts/embed-migrations.mjs` 内嵌为 `src/migrations.gen.ts`（`pnpm --filter @subloom/db db:generate` 一并完成）。`migrate(db)` 与运行时无关，用 `__subloom_migrations` 表记录已执行的迁移，每个迁移在一个事务中执行；Node 启动时、Workers 首次请求时（`bootstrap`）调用。测试用 `import.meta.glob` 校验内嵌内容与 SQL 文件一致，CI 中重新生成并检查没有未提交的变化。迁移只增不改，已发布的迁移文件不得修改。

### 5.3 API

管理接口（`Authorization: Bearer <ADMIN_TOKEN>`）：

```
GET    /api/meta                     版本、运行平台、密钥来源、各导出器能力矩阵
GET    /api/sources                  列表
POST   /api/sources                  新建
GET    /api/sources/:id
PATCH  /api/sources/:id
DELETE /api/sources/:id
POST   /api/sources/:id/refresh      立即拉取（同步执行，返回结果）
GET    /api/sources/:id/nodes        预览解析出的节点（读取 src:<id>:nodes）
GET    /api/sources/:id/logs         最近的拉取日志（新的在前）

GET    /api/profiles
POST   /api/profiles
GET    /api/profiles/:id
PATCH  /api/profiles/:id
DELETE /api/profiles/:id
POST   /api/profiles/:id/preview?target=surge   返回 { text, warnings, pipelineWarnings, sources }

GET    /api/outputs                  列表（可选 ?profileId=）
POST   /api/outputs
GET    /api/outputs/:id
PATCH  /api/outputs/:id
DELETE /api/outputs/:id
POST   /api/outputs/:id/rotate       重新生成 token

GET    /api/backup                   导出全部数据（订阅 URL 明文，提示用户妥善保存）
POST   /api/restore                  用备份全量替换现有数据
```

- 错误响应统一为 `{ error: { code, message } }`：未认证 401（`UNAUTHORIZED`）、请求不合法 400（`INVALID_REQUEST`）、不存在 404（`NOT_FOUND`、还没有节点缓存时 `NO_CACHE`）。
- 订阅源：`POST` 的请求体为 `{ name, kind: 'remote', url, userAgent?, ttlSec? }` 或 `{ name, kind: 'local', content }`；`kind` 创建后不可修改。返回的订阅源包含明文 `url`（管理接口已认证）和解析后的 `userinfo`，列表不返回本地订阅的 `content`。新建远程订阅不会自动拉取，由前端随后调用 refresh；本地订阅在新建和修改 `content` 时立即解析并写入 nodes。删除订阅源时同时从所有 profile 的 `sourceIds` 中移除。
- `refresh` 成功返回 200 `{ source, nodeCount, warnings }`；失败返回 502 `{ error, source }`，`error.code` 为 `SSRF_BLOCKED`、`FETCH_FAILED`、`PARSE_FAILED` 或 `DECRYPT_FAILED`。
- **meta**：`{ name: 'subloom', version, coreVersion, platform: 'node' | 'workers', secretKeySource: 'env' | 'generated', targets: { <target>: Capabilities } }`。`targets` 只列出已实现的导出器。`secretKeySource` 为 `generated` 时前端提示用户设置 `SECRET_KEY`（原因见 5.5）。
- **profiles**：`POST` 的请求体为 `{ ir: Profile, pipeline?: PipelineOp[], sourceIds?: string[] }`（`ir` 用 `ProfileSchema` 校验，`pipeline` 默认 `[]`，`sourceIds` 默认 `[]`，必须是已存在的订阅源且不重复），`PATCH` 可修改其中任意几项。返回 `{ profile: { id, name, ir, pipeline, sourceIds, createdAt, updatedAt } }`，`name` 即 `ir.name`；列表不返回 `ir` 和 `pipeline`。删除 profile 时同时删除它的输出及其缓存。
- **preview**：`target` 为已实现的导出器（`mihomo`、`surge`）。请求体可选，为 `{ ir?, pipeline?, sourceIds?, options? }`，给出的项覆盖已保存的值（前端实时预览尚未保存的编辑），`options` 为导出选项（不含 `proxyProvider`）。按 `sourceIds` 的顺序读取各订阅源的节点缓存并拼接 → 流水线 → 导出，不使用也不写入生成结果缓存。返回 `{ text, warnings: CompatWarning[], pipelineWarnings: PipelineWarning[], sources: [{ id, nodeCount }] }`，还没有节点缓存的订阅源 `nodeCount` 为 null（生成时跳过）。
- **outputs**：`POST` 的请求体为 `{ profileId, target, options? }`。`target` 为已实现的导出器或 `auto`；`shadowrocket`、`loon` 的导出器实现前返回 400。`options` 为 `{ export?: ExportOptions（不含 proxyProvider）, nodes?: 'inline' | 'provider' }`，`nodes` 默认 `inline`，`provider` 只影响 mihomo（见第 4 节"mihomo 导出器"），provider 指向 `/sub/<token>/proxies`。`PATCH` 可修改 `target`、`options`。返回 `{ output: { id, profileId, target, token, path: '/sub/<token>', url, options, lastAccessAt, createdAt } }`，`url` 为设置了 `PUBLIC_URL` 时的完整链接（`PUBLIC_URL` + `path`），否则为 null（由前端用后端地址拼接）。`rotate` 生成新 token，旧链接立即失效（404）。删除和 rotate 时清除该输出的生成结果缓存。

公开接口（无需认证，靠 token）：

```
GET /sub/:token            生成好的配置
GET /sub/:token/proxies    经流水线处理的订阅节点（mihomo 的 proxies 列表），供 nodes: 'provider' 的 proxy-providers 引用
GET /healthz               { status: 'ok' }；初始化或数据库访问失败时 503 { status: 'error' }（不含细节）
```

`/sub/:token` 的行为：

1. 根据 token 找到 output（找不到时 404）。target 为 `auto` 时按 User-Agent 识别客户端（见下方"User-Agent 识别"，识别失败默认 mihomo）。
2. 读取生成结果缓存，按缓存键决定直接返回、先返回旧结果并在后台刷新（stale-while-revalidate），还是同步生成（见下方"生成结果缓存"）。生成过程与 preview 相同：节点缓存拼接 → 流水线 → 导出；`nodes: 'provider'` 时 mihomo 配置不含订阅节点。
3. 响应头：
   - `Content-Type: text/plain; charset=utf-8`
   - `subscription-userinfo`：合并 profile 中所有订阅源的流量与到期时间（见下方"流量信息合并"），没有任何来源有流量信息时不返回该头
   - `profile-update-interval`：以小时为单位（mihomo 系客户端读取），取 profile 中远程订阅源 `ttlSec` 的最小值（没有远程订阅源时为默认的 6 小时），向上取整，至少 1
   - `Content-Disposition: attachment; filename*=UTF-8''<profile名>.yaml`（mihomo 系客户端用作配置名；Surge 为 `.conf`）
   - `X-SubLoom-Target`：实际导出的客户端；按 UA 回退时另有 `X-SubLoom-Fallback: <识别出的客户端>`
4. Surge 输出在首行写入 `#!MANAGED-CONFIG <当前URL> interval=<秒> strict=false`（间隔同上，单位为秒）。该行在响应时添加，不进入缓存。
5. 更新 `last_access_at`。

`/sub/:token/proxies` 同样使用生成结果缓存（target 记为 `proxies`），响应头同上（没有 MANAGED-CONFIG）。`proxy-providers` 的 `interval` 与 `profile-update-interval` 相同（单位为秒）。

**对外链接**（MANAGED-CONFIG 中的当前 URL、proxy-providers 的地址、输出的 `url` 字段）按以下顺序生成：

1. 设置了 `PUBLIC_URL`（如 `https://sub.example.com` 或带路径前缀的 `https://example.com/subloom`）：`PUBLIC_URL` 去掉末尾的 `/` 后拼接请求路径（和查询参数）。请求头一概不看。
2. 否则 `TRUST_PROXY=true` 时，按 `X-Forwarded-Proto`（只接受 `http`、`https`）、`X-Forwarded-Host`（只接受合法的主机名和端口）改写请求 URL 的协议和主机名。只应在 SubLoom 前面确实有反向代理、且代理会覆盖这两个头时开启，否则任何人都能伪造。
3. 都未设置：用请求的 URL（Node 下来自请求的 `Host` 头；Workers 下为实际访问的地址）。

`PUBLIC_URL`、`TRUST_PROXY` 默认都不设置，Node 和 Workers 都支持。对外链接只影响返回给该请求者的内容（MANAGED-CONFIG 行在响应时添加；provider 地址参与缓存键，见下），不会污染其他请求的结果。

**User-Agent 识别**（不区分大小写，按顺序匹配，测试表覆盖常见客户端的真实 UA）：

| 客户端 | UA 特征 | 导出 |
|---|---|---|
| Shadowrocket | `Shadowrocket` | mihomo（回退） |
| Loon | `Loon` | mihomo（回退） |
| Surge | `Surge`（含 `Surge iOS`、`Surge Mac`） | surge |
| Stash | `Stash` | mihomo |
| mihomo 系 | `mihomo`、`clash.meta`、`clash-verge`、`ClashX`、`FlClash`、`Clash Nyanpasu`、`ClashMetaForAndroid`、`Clash`（含 Clash for Windows / Android 等） | mihomo |
| 其他 | | mihomo（默认） |

- Shadowrocket、Loon 的导出器实现前回退到 mihomo（Shadowrocket 能读取 Clash/mihomo 订阅中的节点，Loon 可将其作为节点订阅），响应头带 `X-SubLoom-Fallback`，日志记一条 info。导出器实现后改为对应的 target。
- 识别顺序中 Shadowrocket、Loon 在前：它们的 UA 可能带有其他客户端的关键字。

**生成结果缓存**：BlobStore 中每个输出、每个 target 一份（`out:<id>:<target>`），内容为 `{ configKey, nodesKey, text, generatedAt }`，不设 TTL，删除或 rotate 输出、删除 profile 时清除。

- `configKey`：SHA-256（profile 的 `ir_json`、`pipeline_json`、`source_ids_json`，输出的 `options_json`，target，core 版本 `CORE_VERSION`，provider 地址）。
- `nodesKey`：SHA-256（profile 各订阅源的 id 与 `nodes_fetched_at`）。`nodes: 'provider'` 的 mihomo 配置不含订阅节点，`nodesKey` 为空串。
- 任一项变化都会自动失效，不需要手动清理：
  - 没有缓存，或 `configKey` 不同（用户修改了 profile、导出选项，或升级了 core）：同步生成，写入缓存后返回，客户端下一次更新就能拿到新配置。
  - 只有 `nodesKey` 不同（订阅刷新带来了新节点）：先返回旧结果，同时用 `waitUntil` 在后台重新生成（stale-while-revalidate）。同一个 platform 上同一份缓存同时只有一个后台生成任务。
  - 都相同：直接返回。

**流量信息合并**（`subscription-userinfo`）：只看 profile 中的订阅源。

- 没有流量信息的来源（本地订阅、上游没有该头、从未成功拉取）不参与合并；所有来源都没有时不返回该头。
- `upload`、`download`、`total` 分别对给出了该字段的来源求和，没有任何来源给出的字段省略。
- `expire` 取给出了该字段的来源中最早的一个；`expire=0`（部分面板表示不过期）视为未给出。

**备份与恢复**：

- `GET /api/backup` 返回 `{ format: 'subloom-backup', version: 1, exportedAt, warning, sources, profiles, outputs }`，带 `Content-Disposition: attachment`、`Cache-Control: no-store`。`warning` 字段（英文）和接口文档都提示：**备份中的订阅链接是明文（常带有机场 token），输出 token 也可直接访问配置，请妥善保管，不要分享或上传到公开位置**。
  - `sources`：`{ id, name, kind, url, content, userAgent, ttlSec, createdAt, updatedAt }`，`url` 为明文（无法解密时为 null）。
  - `profiles`：`{ id, ir, pipeline, sourceIds, createdAt, updatedAt }`。
  - `outputs`：`{ id, profileId, target, token, options, createdAt }`，含 token，恢复后客户端中的链接仍然有效。
  - 不含管理令牌、密钥、节点和生成结果缓存、拉取日志。
- `POST /api/restore` 的请求体为备份内容。先完整校验（格式、版本、各字段、id 和 token 不重复、引用的订阅源和 profile 存在），通过后清空并替换全部数据：删除现有订阅源、profile、输出、拉取日志及其缓存，再写入备份中的数据，URL 用当前密钥重新加密。本地订阅立即解析；远程订阅需要重新拉取（由前端或定时任务触发）。返回 `{ restored: { sources, profiles, outputs } }`。校验失败返回 400，不改动现有数据。D1 不支持交互式事务，写入过程中出错时可能只恢复了一部分，此时重新执行 restore 即可。

### 5.4 订阅拉取

- 每个订阅可自定义 User-Agent。默认 `clash.meta`：常见机场面板按 UA 中的 `clash`、`meta` 关键字返回 mihomo YAML。
- 自动识别返回内容（`importSubscription`）：mihomo YAML、Base64 编码的 URI 列表、纯文本 URI 列表。
- 解析上游响应头里的 `subscription-userinfo`（`upload`、`download`、`total`、`expire`，均为非负整数，缺失的字段省略）并保存；成功拉取但响应中没有该头时清空。
- 拉取失败时**保留上一次成功的缓存**（`src:<id>:raw`、`src:<id>:nodes`、`userinfo_json` 都不动），记录错误（`last_status`、`last_error`、`fetch_logs`），界面上展示。以下都算失败：SSRF 检查不通过、网络错误、超时、非 2xx、响应体超限、无法识别格式或解析出 0 个节点（防止机场返回错误页时清空缓存）。
- 超时 15 秒（含读取响应体），响应体上限 10 MB（先看 `Content-Length`，再在读取时计数，超出即中断）。
- 重定向手动处理（`redirect: 'manual'`），每一跳都重新做 SSRF 检查，最多 5 次。
- 刷新间隔 `ttl_sec` 默认 6 小时，最小 5 分钟。

### 5.5 安全

- **管理令牌**：优先读环境变量 `ADMIN_TOKEN`；未设置时首次启动自动生成（32 字节随机数，base64url），SHA-256 哈希后存入 settings（`admin_token_hash`），明文只打印一次到日志（Docker 日志 / Workers 控制台日志；并发初始化时只有写入成功的一方打印）。校验时对请求中的令牌取 SHA-256，与期望的哈希做常量时间比较。
- **加密**：订阅 URL 使用 AES-256-GCM 加密存储，密钥由 `SECRET_KEY` 经 HKDF-SHA256 派生。密文格式 `v1.<iv>.<密文+tag>`（base64url），以 `source:<id>` 作为附加认证数据，密文不能挪到其他订阅上使用。未设置 `SECRET_KEY` 时自动生成并存入 settings（`secret_key`），日志中提醒：密钥与密文在同一个数据库中，数据库泄露即可解密，要真正保护 URL 请设置 `SECRET_KEY` 环境变量（丢失则无法解密）。settings 中另存一段用当前密钥加密的校验值（`secret_key_check`），启动时解不开则在日志中报错（`SECRET_KEY` 被更换），对应订阅刷新时报 `DECRYPT_FAILED`。
- **密钥来源**：自动生成的密钥与密文存在同一个数据库中，数据库泄露时加密形同虚设。`/api/meta` 返回 `secretKeySource`（`env`：来自 `SECRET_KEY` 环境变量；`generated`：自动生成并存在数据库中），为 `generated` 时前端显著提示用户设置 `SECRET_KEY`。部署文档推荐通过环境变量（Docker）或 `wrangler secret put SECRET_KEY`（Workers）设置，并说明：设置后已有的密文需要用原密钥解开，因此应在添加订阅之前设置，或设置后重新填写订阅 URL（也可以先备份、设置后再恢复）。
- **输出 token**：32 字节随机数，base64url 编码。token 即访问凭据，日志中只出现前 4 个字符（如 `abcd…`），不出现完整 token。
- **备份**：`/api/backup` 导出明文订阅链接和输出 token，接口返回的 `warning` 字段与文档都提示用户妥善保管（见 5.3"备份与恢复"）。
- **SSRF**：只允许 `http`、`https`。默认拒绝拉取私有和保留地址：IPv4 的 0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.0.0/24、192.0.2/24、192.168/16、198.18/15、198.51.100/24、203.0.113/24、224/4、240/4；IPv6 的 ::/96（含 `::`、`::1`）、100::/64、2001:db8::/32、fc00::/7、fe80::/10、fec0::/10、ff00::/8，以及内嵌 IPv4 的 `::ffff:0:0/96`、`64:ff9b::/96`、`2002::/16` 按内嵌的 IPv4 判断；`localhost`、`*.localhost` 视为私有。Node 下用 `resolveHost` 解析 DNS，任一地址为私有即拒绝（解析失败同样拒绝）；Workers 无法解析 DNS，平台本身不允许访问内网地址。设置 `ALLOW_PRIVATE_FETCH=true` 可关闭全部检查（用于拉取局域网内的订阅）。
- **日志脱敏**：日志中不出现完整订阅 URL、节点地址、密码和完整的输出 token。
- **CORS**：管理接口只允许 `CORS_ORIGINS` 中列出的来源（默认包含实例自身和官方前端域名）。

### 5.6 Workers 的限制与对策

| 限制 | 对策 |
|---|---|
| 免费版单次请求 CPU 时间很短（约 10ms） | 生成结果缓存 + stale-while-revalidate；M2 里做性能基准测试（500 个节点），超限时在文档中说明可升级付费计划或改用 Docker |
| 500 节点完整链路（解析 mihomo YAML → 流水线 → 导出）CPU 耗时 | M2 中优化：导入改用 `js-yaml`、导出改用自写的 YAML 生成器。开发机（Node 22，200 次中位数）上完整链路 → mihomo 从 139ms 降到 17ms（导入 90 → 9.4ms，其中 js-yaml 约 6.5ms；导出 51 → 5.2ms），→ Surge 13ms。仍超出免费版 10ms，M5 在真实 Workers 环境中再测一次，再决定继续优化还是在文档中说明需要付费计划 |
| 不支持 eval | 自定义脚本功能仅 Docker 提供，前端根据 `/api/meta` 的平台信息隐藏 |
| 出口 IP 属于 Cloudflare，部分机场会拦截 | 文档说明，建议此类用户使用 Docker |
| D1 有单行大小限制 | 大内容放 KV |
| KV 的 `expirationTtl` 最小 60 秒 | KV BlobStore 把更短的 TTL 提高到 60 秒（目前没有使用 TTL 的 key） |
| KV 免费版每天 1000 次写入、10 万次读取；写入最终一致（其他地区最多约 60 秒后可见） | 生成结果只在缓存键变化时写入；每次刷新订阅写 2 个 key。订阅很多或刷新很频繁时文档中提示可能超出免费额度 |
| 定时任务（Cron Triggers）同样受 CPU 时间限制 | 每 10 分钟触发一次，只刷新到期的订阅；解析 500 节点的订阅在免费版上可能超限（见 M5 的实测），超限时文档中说明 |
| 运行时里的计时函数在同步执行期间不前进（防止计时攻击），代码中无法自己测量 CPU 时间 | 在 Cloudflare 控制台查看每次请求的 CPU 时间（见 M5 验收步骤） |

---

## 6. 部署

### Docker

- 多阶段构建，产出单一镜像，内含 server 和前端静态文件。
- 多架构：`linux/amd64`、`linux/arm64`（覆盖 NAS 和树莓派）。
- 发布到 GHCR，镜像名 `ghcr.io/<owner>/subloom`（可选同时发布到 Docker Hub）。
- 数据目录 `/data`（SQLite 数据库 + 缓存文件），通过 volume 挂载。
- 环境变量：`ADMIN_TOKEN`、`SECRET_KEY`（文档推荐设置，见 5.5"密钥来源"）、`PORT`（默认 3000）、`DATA_DIR`（默认 `./data`，镜像中为 `/data`）、`CORS_ORIGINS`（逗号分隔）、`ALLOW_PRIVATE_FETCH`、`PUBLIC_URL`、`TRUST_PROXY`（见 5.3"对外链接"）、`REFRESH_INTERVAL_MIN`（定时刷新的检查间隔，默认 10，0 为关闭）。全部可选。
- 数据目录结构：`subloom.db`（SQLite）、`blobs/`（文件 BlobStore，一个 key 一个文件，文件名为 key 的百分号编码，先写临时文件再改名）。
- 启动时自动执行数据库迁移。
- 提供 `HEALTHCHECK` 和 `docker-compose.yml` 示例。

### Cloudflare Workers

**配置**：`wrangler.jsonc` 放在**仓库根目录**（Deploy 按钮只能以仓库根目录或一个自包含全部依赖的子目录为根，而 `apps/worker` 依赖工作区中的 `@subloom/server` 等包；见下方"Deploy to Cloudflare 按钮"）。Workers 专有代码仍然只在 `apps/worker`：

- `main`：`apps/worker/src/index.ts`（`fetch` 与 `scheduled` 处理器）。
- D1 绑定 `DB`（`database_name: subloom`）、KV 绑定 `BLOBS`，**不写资源 ID**，由 wrangler 的自动创建（automatic provisioning）在首次部署时创建，之后的部署即使配置中没有 ID 也继续绑定同一个资源（[官方说明](https://developers.cloudflare.com/changelog/2025-10-24-automatic-resource-provisioning/)）。按 wrangler 4.148 的实现：D1 先沿用已部署 Worker 上同名绑定的数据库，否则按名称连接账号中已有的 `subloom` 数据库，都没有才新建；KV 沿用已部署 Worker 上的绑定，否则新建 `subloom-blobs`。因此在控制台删除 Worker 后再部署，D1（全部数据）会重新连上；KV 只存缓存，新建后由刷新订阅重新生成。CI 中不会把 ID 写回配置文件。
- Cron Triggers：每 10 分钟（`*/10 * * * *`，与 Node 的 `REFRESH_INTERVAL_MIN` 默认值一致）调用 `runScheduledRefresh`，用 `ctx.waitUntil` 等待完成。
- 静态资源：`assets.directory` 指向 `apps/web/dist`（构建产物），`not_found_handling: single-page-application`；`run_worker_first` 为 `/api/*`、`/sub/*`、`/healthz`，这些路径总是交给 Worker，其余路径优先返回静态文件。
- `compatibility_date` 不晚于 `@cloudflare/vitest-pool-workers` 自带的 workerd 支持的日期（目前 `2026-08-15`），保证 Workers 测试与线上的运行时行为一致；升级 pool-workers 时一起调整。
- `observability.enabled: true`：开启 Workers Logs（自动生成的管理令牌、错误日志、每次请求的 CPU 时间都在这里查看）。
- 普通变量（`CORS_ORIGINS`、`ALLOW_PRIVATE_FETCH`、`PUBLIC_URL`、`TRUST_PROXY`）由用户在控制台设置，默认不设置；`keep_vars: true` 让部署时保留控制台中设置的变量（否则 `wrangler deploy` 会覆盖它们；Secret 总是保留）。
- 根 `package.json` 的 `cloudflare.bindings` 为 Deploy 按钮提供各绑定和 Secret 的说明。

**迁移**：首次请求时（`bootstrap`）自动执行。D1 不支持交互式事务，每个迁移连同迁移记录用 `db.batch` 一次提交（D1 的 batch 在一个事务中执行，任一语句失败整体回滚）；多个实例并发执行时，后提交的一方失败回滚后重新确认该迁移已执行即可。用户升级时零操作。

**密钥**：`ADMIN_TOKEN`、`SECRET_KEY` 由用户手动设置为 Secret，部署 workflow 不接触它们：本地执行 `npx wrangler secret put SECRET_KEY`（`ADMIN_TOKEN` 同理），或在控制台 Workers & Pages → subloom → Settings → Variables and Secrets 中添加，类型选 Secret（两者等价）。未设置时的行为与 Node 一致：自动生成，管理令牌只在首次请求时打印一次到日志（在控制台 Workers Logs 中查看），`/api/meta` 的 `secretKeySource` 为 `generated`。`SECRET_KEY` 应在添加订阅之前设置（见 5.5"密钥来源"）。

**GitHub Actions 部署**（`.github/workflows/deploy-workers.yml`）：

- 触发：main 分支上的 CI 成功后自动部署，也可在 Actions 页面手动触发（workflow_dispatch）。仓库没有配置 `CLOUDFLARE_API_TOKEN` Secret 时跳过（不报错），因此不部署的 fork 不受影响。
- 步骤：安装依赖 → `pnpm build`（含前端静态文件）→ `pnpm run deploy`（根目录的 `wrangler deploy`）。
- 凭据：用户在 GitHub 仓库的 Secrets 中设置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，只在部署步骤中通过环境变量传给 wrangler。
- API Token 的最小权限（Account 级别，只授予要部署的那个账号）：**Workers Scripts: Edit**（上传 Worker、静态资源、Cron Triggers、启用 workers.dev 域名）、**D1: Edit**（首次部署自动创建数据库）、**Workers KV Storage: Edit**（首次部署自动创建 KV 命名空间）。迁移在运行时由 Worker 自己执行，不需要额外的 D1 权限；不需要任何 Zone 权限（使用 workers.dev 域名时）。绑定自定义域名时另加该 Zone 的 **Workers Routes: Edit**。
- **fork 同步上游**（`.github/workflows/sync-upstream.yml`）：只在 fork 中运行，每天一次（也可手动触发），用 GitHub 的 merge-upstream 接口把上游的默认分支同步到 fork，有新提交时触发部署 workflow（`GITHUB_TOKEN` 推送的提交不会触发其他 workflow，因此显式 dispatch）。上游改动了 workflow 文件时 `GITHUB_TOKEN` 没有权限同步，需要在 GitHub 页面上点 "Sync fork"。GitHub 默认不在 fork 中运行定时 workflow，需要先在 fork 的 Actions 页面启用。

**Deploy to Cloudflare 按钮**（以[官方文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/)为准）：

- 按钮读取仓库根目录的 wrangler 配置，用 Workers Builds 构建并部署（构建命令、部署命令取自根 `package.json` 的 `build`、`deploy` 脚本），D1、KV 由按钮流程自动创建，用户可以在页面上修改 Worker 名和资源名。
- D1 迁移：官方建议在 `deploy` 脚本中执行；SubLoom 在首次请求时自动迁移，不需要。
- Secrets：按钮从 `.dev.vars.example` 读取需要的 Secret，在页面上提示用户填写；SubLoom 在其中列出 `ADMIN_TOKEN`、`SECRET_KEY`。
- 按钮会在用户自己的 GitHub / GitLab 账号下**新建一个仓库**（复制，而不是 fork），并把新建资源的 ID 写入新仓库的 wrangler 配置；之后推送到该仓库时由 Workers Builds 自动部署。
- 限制：源仓库必须公开（github.com 或 gitlab.com）；新仓库不是 fork，不能用"fork 同步上游"的 workflow，升级需要用户自己把上游合并进来（文档中写明命令）；只支持一个 Worker 应用。做不到的部分（自定义域名、`PUBLIC_URL` 等变量、事后修改 Secret）在部署文档中写明手动步骤。

**部署文档**：`docs/deploy-workers.md`（M8 的 README 中链接到它），包含以上全部内容和首次部署、升级、查看日志与 CPU 时间、常见问题。

### 官方前端

- 部署在 Cloudflare Pages，纯静态，不存任何数据。
- 用户输入自己的后端地址和管理令牌后连接使用。

---

## 7. 前端（v0.1 范围）

页面：

1. **连接页**：输入后端地址和管理令牌（自带前端时后端地址自动填当前域名）。令牌存在 localStorage。连接后若 `/api/meta` 的 `secretKeySource` 为 `generated`，全局显著提示用户设置 `SECRET_KEY`（附部署文档链接）。
2. **订阅源**：列表、新增/编辑、立即刷新、查看节点、查看最近一次拉取状态和错误、流量与到期信息。
3. **配置编辑器**（核心页面）：
   - 选择来源订阅；从预设模板新建。
   - 策略组：树形视图展示嵌套关系，拖拽排序，编辑类型和成员，按正则筛选节点。
   - 规则：列表，拖拽排序，快速添加；规则集从内置的常用规则源中选择。
   - 右侧（移动端为切换标签）实时预览：选择目标客户端，显示生成的配置文本和兼容性警告。
4. **输出链接**：为配置创建输出（选择客户端），复制链接、显示二维码、重新生成 token。
5. **备份与恢复**：下载备份时提示其中含明文订阅链接，需妥善保管；恢复前确认将替换全部数据。

要求：响应式布局，手机上可用；中英文；深色模式。

---

## 8. 测试与 CI

- **core**：每个导入器和导出器都有 golden 测试（`test/fixtures/<case>/input.*` 与 `expected.<target>.*`）。更新快照必须是有意为之。
- **Surge 校验**：Surge 没有命令行校验工具，`expected.surge.*` 快照逐个对照官方手册人工核对；新增功能时在 PR 中附完整的 Surge 示例输出，在手机上导入测试。
- **mihomo 实际校验**：CI 按固定版本（tag + commit SHA）从源码构建 mihomo（go.sum 校验依赖），对所有 `expected.mihomo.*` golden 输出执行 `mihomo -t`。GEOIP/GEOSITE 数据文件由 mihomo 首次运行时自动下载，所有文件共用一个数据目录并在 CI 中缓存。
- **server**：同一套 API 集成测试分别在 Node（better-sqlite3）和 Workers（vitest-pool-workers + D1/KV 模拟）下运行。packages/* 的测试不能使用 Node API（拿不到 better-sqlite3），因此集成测试写在 `packages/server/test/api/suite.ts`（`describeApi(createPlatform)`，不以 `.test.ts` 结尾，server 自己不运行），由 `apps/node/test`（M5 起还有 `apps/worker/test`）传入各自的 Platform 运行；packages/server 自己只运行不需要数据库的单元测试（加密、SSRF、拉取、userinfo 解析与合并、UA 识别、缓存键）。
- **测试中不访问真实网络**：各包的 Vitest setup 文件把全局 `fetch` 替换为直接抛错的函数，测试中按需 mock；DNS 解析用假的 `resolveHost`。上游响应头使用 `packages/core/test/fixtures/import/subscription-headers.json`。
- **性能基准**：500 节点订阅 → 解析 → 流水线 → 导出，记录耗时，在 CI 中监控回退。`packages/core/test/perf/` 中确定性生成 500 个节点（常见协议轮流出现）；`chain.bench.ts`（`pnpm --filter @subloom/core bench`）分别测量解析、流水线、各导出器和完整链路，CI 把结果写入 job summary；`chain.test.ts` 给完整链路设宽松上限（100ms，取 5 次中最快的一次；开发机上约 15–20ms），只拦截数量级的回退，避免 runner 性能波动导致误报。
- **CI 流程**：lint → typecheck → test → build；main 分支打 tag 时发布 Docker 镜像。

---

## 9. 里程碑

每个里程碑大致对应 Claude Code 的一到几次会话。完成后在此处勾选。

### M0 仓库脚手架
- [x] pnpm workspaces + Turborepo，TypeScript strict 基础配置，Biome，Vitest
- [x] 创建 3 节中的所有包和应用的空壳，包名按"命名约定"使用 `@subloom/*`
- [x] CLAUDE.md（硬性约束、常用命令）
- [x] GitHub Actions：lint、typecheck、test、build
- **验收**：`pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部通过

### M1 core：IR 与 mihomo
- [x] IR zod schema（第 4 节）
- [x] 导入器：mihomo YAML；URI（ss、vmess、vless 含 reality、trojan、hysteria2）；Base64 订阅自动识别
- [x] mihomo 导出器（含 rule-providers 风格的规则集输出；proxy-providers 依赖输出链接，放到 M4）
- [x] 流水线操作（第 4 节全部）
- [x] 预设模板 2 套（极简、常用分流）
- [x] golden 测试，CI 中执行 `mihomo -t`
- [x] 有测试后去掉各包 `test` 脚本中的 `--passWithNoTests`（还没有测试的包不声明 `test` 脚本，加测试时再加回）
- **验收**：样例订阅导入后经流水线处理，导出的配置能通过 `mihomo -t`

### M2 core：Surge 与兼容性警告
- [x] Surge 导出器（节点、策略组、规则、RULE-SET、General、DNS 基础项）
- [x] 能力矩阵与 CompatWarning 机制，降级逻辑和引用清理
- [x] 性能基准测试（500 节点）
- [x] M1 遗留：规则集下载策略组与镜像（第 4 节"规则集下载"）、流水线 `force-udp`
- **验收**：同一份 profile 导出 mihomo 和 Surge 均正确；含不支持功能时警告完整准确

### M3 server：存储与订阅源
- [x] `packages/db` schema 与迁移
- [x] Platform 与 BlobStore 接口，`createApp(platform)`
- [x] 管理令牌（自动生成逻辑）、加密模块、SSRF 检查
- [x] sources 增删改查、拉取（UA、格式识别、userinfo、失败保留缓存）、拉取日志
- [x] `apps/node` 入口：better-sqlite3、文件 BlobStore、定时刷新
- **验收**：Node 下可通过 API 添加订阅并刷新，节点预览正确，数据库中 URL 为密文

### M4 server：配置与输出链接
- [x] profiles 增删改查、preview 接口
- [x] outputs 增删改查、rotate
- [x] `/sub/:token`：UA 识别（测试表覆盖常见客户端）、缓存与 stale-while-revalidate（缓存键见 5.3）、全部响应头（含多来源 userinfo 合并）、Surge MANAGED-CONFIG；日志中不出现完整 token
- [x] backup / restore（提示明文链接需妥善保管）、`/api/meta`（含 `secretKeySource`）、`/healthz`
- [x] mihomo 导出器支持以 `proxy-providers` 引用托管的节点列表（M1 推迟至此），`/sub/:token/proxies`
- **验收**：mihomo 客户端和 Surge 能通过输出链接导入配置，并显示流量信息

### M5 Workers 入口
- [x] M4 遗留：`PUBLIC_URL`、`TRUST_PROXY`（5.3"对外链接"），Node 与 Workers 共用 `parseEnv`
- [x] `apps/worker`：D1、KV BlobStore、Cron Triggers、waitUntil、platform 名称
- [x] wrangler 配置（仓库根目录）、静态资源托管、D1 自动迁移（`db.batch`）
- [x] API 集成测试在 Workers 环境下全部通过（`@cloudflare/vitest-pool-workers`，D1、KV 由 miniflare 模拟）
- [x] GitHub Actions 部署 workflow、fork 同步上游 workflow
- [ ] 在真实的 Workers 环境（非本地 workerd 模拟）中重测 500 节点完整链路的 CPU 耗时（本地 Node 的数字不能完全代表 Workers），结果写入 5.6；超出免费版限制时在部署文档中说明（需要部署到用户的账号后按验收步骤 4 测量，测量工具 `scripts/workers-perf.mjs` 已就绪）
- [x] Deploy 按钮与部署文档（`docs/deploy-workers.md`）
- **验收**：Fork 后可一键部署到 Cloudflare，功能与 Node 版一致。步骤：
  1. 在 GitHub 仓库的 Secrets 中设置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，手动运行 Deploy Workers workflow（或推送到 main），部署成功；控制台中出现自动创建的 D1、KV。
  2. 设置 `SECRET_KEY`、`ADMIN_TOKEN` Secret；访问 `/healthz` 返回 ok，`/api/meta` 的 `platform` 为 `workers`、`secretKeySource` 为 `env`。
  3. 添加订阅、刷新、建 profile 和输出，客户端通过输出链接导入（同 M4 的验收）；等待一次 Cron Trigger 后订阅按到期时间刷新。
  4. **CPU 时间**：Workers 运行时里的计时函数在同步执行期间不前进，不能在代码中自己计时，只能在控制台查看。先运行 `node scripts/workers-perf.mjs`（环境变量 `SUBLOOM_URL`、`SUBLOOM_ADMIN_TOKEN`，需要先 `pnpm build`）：它在部署好的实例上创建一个 500 节点的本地订阅，依次请求刷新（解析）、preview（流水线 + 导出 mihomo / Surge）和输出链接（缓存命中），各若干次，最后删除创建的数据。然后在控制台查看：
     - Workers & Pages → subloom → **Metrics**：**CPU Time per execution** 图表按分位数（中位数、P90、P99 等）展示一段时间内的 CPU 时间。
     - Workers & Pages → subloom → **Observability**（Workers Logs）：每次请求的调用日志（Invocation Log）中有该次请求的 **CPU Time** 和 **Wall Time**；在 Query Builder 中按请求路径过滤，对 CPU Time 取中位数、P90 等，即可分别得到解析、导出、缓存命中三种请求的 CPU 时间。超出限制的请求结果为 `exceededCpu`。
     - 把结果写入 5.6，超出免费版 10ms 时在部署文档中说明（升级付费计划或改用 Docker）。

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
- 支持 Shadowrocket 格式的 vmess 链接（`vmess://base64(cipher:uuid@host:port)?params`，非 v2rayN JSON）
- core 打包为可在 Surge/Loon 脚本环境中运行的版本

---

## 11. 待决定事项

- [x] 项目名称：SubLoom
- [ ] 确认 GitHub 组织/用户名、npm 组织 `subloom` 可注册
- [ ] 官方前端域名（如 subloom.app / subloom.dev）
- [ ] 许可证：AGPL-3.0（防止闭源商用）或 MIT（传播更广）
- [x] 预设模板默认引用哪些社区规则仓库：blackmatrix7/ios_rule_script（引用 URL 即可，不复制内容）

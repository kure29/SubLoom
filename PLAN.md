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
- 节点直接写入 `proxies`。`proxy-providers`（指向托管节点列表的链接）依赖 M4 的输出链接，届时再做。
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
| 500 节点完整链路（解析 mihomo YAML → 流水线 → 导出）CPU 耗时 | M2 中优化：导入改用 `js-yaml`、导出改用自写的 YAML 生成器。开发机（Node 22，200 次中位数）上完整链路 → mihomo 从 139ms 降到 17ms（导入 90 → 9.4ms，其中 js-yaml 约 6.5ms；导出 51 → 5.2ms），→ Surge 13ms。仍超出免费版 10ms，M5 在真实 Workers 环境中再测一次，再决定继续优化还是在文档中说明需要付费计划 |
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
- **Surge 校验**：Surge 没有命令行校验工具，`expected.surge.*` 快照逐个对照官方手册人工核对；新增功能时在 PR 中附完整的 Surge 示例输出，在手机上导入测试。
- **mihomo 实际校验**：CI 按固定版本（tag + commit SHA）从源码构建 mihomo（go.sum 校验依赖），对所有 `expected.mihomo.*` golden 输出执行 `mihomo -t`。GEOIP/GEOSITE 数据文件由 mihomo 首次运行时自动下载，所有文件共用一个数据目录并在 CI 中缓存。
- **server**：同一套 API 集成测试分别在 Node（better-sqlite3）和 Workers（vitest-pool-workers + D1/KV 模拟）下运行。
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
- [ ] mihomo 导出器支持以 `proxy-providers` 引用托管的节点列表（M1 推迟至此）
- **验收**：mihomo 客户端和 Surge 能通过输出链接导入配置，并显示流量信息

### M5 Workers 入口
- [ ] `apps/worker`：D1、KV BlobStore、Cron Triggers、waitUntil
- [ ] wrangler 配置、静态资源托管、自动迁移
- [ ] API 集成测试在 Workers 环境下全部通过
- [ ] 在真实的 Workers 环境（非本地 workerd 模拟）中重测 500 节点完整链路的 CPU 耗时（本地 Node 的数字不能完全代表 Workers），结果写入 5.6；超出免费版限制时在部署文档中说明
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
- 支持 Shadowrocket 格式的 vmess 链接（`vmess://base64(cipher:uuid@host:port)?params`，非 v2rayN JSON）
- core 打包为可在 Surge/Loon 脚本环境中运行的版本

---

## 11. 待决定事项

- [x] 项目名称：SubLoom
- [ ] 确认 GitHub 组织/用户名、npm 组织 `subloom` 可注册
- [ ] 官方前端域名（如 subloom.app / subloom.dev）
- [ ] 许可证：AGPL-3.0（防止闭源商用）或 MIT（传播更广）
- [x] 预设模板默认引用哪些社区规则仓库：blackmatrix7/ios_rule_script（引用 URL 即可，不复制内容）

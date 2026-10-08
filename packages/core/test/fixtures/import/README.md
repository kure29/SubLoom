# 导入器测试样本

位于 `packages/core/test/fixtures/import/`，按 CLAUDE.md 的约定每个用例一个目录：`<case>/input.*` 为输入，`<case>/expected.ir.json` 为导入结果快照（由 `toMatchFileSnapshot` 生成）。

**全部为虚构数据**：域名只用 `example.com`，IPv4 只用 TEST-NET 段（203.0.113.0/24、198.51.100.0/24），IPv6 只用文档段 `2001:db8::/32`；密码、UUID、Reality 公钥都是假值。这些样本只保证格式正确，节点本身不能连接。

## 文件说明

| 用例 | 内容 |
|---|---|
| `mihomo-airport-full/` | 典型机场下发的完整配置：15 个节点、4 个策略组、规则集、10 条规则（含 AND 逻辑规则、GEOSITE、no-resolve） |
| `mihomo-proxies-only/` | 只有 `proxies` 字段（provider 风格的响应），同样 15 个节点 |
| `uri-mixed/` | 明文 URI 列表，13 个节点（即上面 15 个节点去掉 TUIC 和 AnyTLS） |
| `uri-mixed-b64/` | 同上内容，标准 Base64（带 padding） |
| `uri-mixed-b64-wrapped/` | 同上内容，Base64 每 76 字符换行（部分机场会这样返回） |
| `uri-mixed-b64url-nopad/` | 同上内容，URL-safe Base64，去掉 padding |
| `uri-edge-cases/` | 各种边界情况，**CRLF 换行**，详见下方 |
| `mihomo-variants/` | 补充样本（手写）：IR 全部 11 种协议、各种传输层、extra 保留、锚点与合并键、原样保留 `12e4`/`01234567` 这类标量、不支持或非法的节点、组、规则、规则集 |
| `uri-variants/` | 补充样本（手写）：URI 参数组合（reality+grpc、h2、httpupgrade、TCP HTTP 伪装、v2ray-plugin、端口列表、mport 等）及若干非法链接 |
| `subscription-headers.json` | 上游响应头示例（流量/到期、更新间隔、文件名），供 M3/M4 使用 |

## 节点覆盖

| 节点名 | 协议 | 测试重点 |
|---|---|---|
| 剩余流量：98.5 GB | ss | 机场信息伪节点，用于过滤测试 |
| 套餐到期：2027-01-01 | ss | 同上 |
| 🇭🇰 香港 01 \| SS | ss aes-256-gcm | SIP002，userinfo 为无 padding 的 base64url |
| 🇭🇰 香港 02 \| SS2022 | ss 2022-blake3-aes-128-gcm | SIP002 中 2022 系列加密使用百分号编码的明文 userinfo |
| 🇯🇵 日本 01 \| SS+obfs | ss + obfs 插件 | `plugin=obfs-local;obfs=http;obfs-host=...` ↔ mihomo `plugin: obfs` + `plugin-opts` |
| 🇯🇵 日本 02 \| VMess WS | vmess ws + tls | v2rayN JSON 格式，端口和 aid 是字符串 |
| 🇺🇸 美国 01 \| VMess gRPC | vmess grpc + tls | JSON 中 `path` 即 serviceName |
| 🇺🇸 美国 02 \| VLESS Reality | vless tcp + reality + vision | 服务器为 IPv4，pbk/sid/fp/flow |
| 🇸🇬 新加坡 01 \| VLESS WS | vless ws + tls | path 中带 `?ed=2048`，URI 中需正确解码 |
| 🇸🇬 新加坡 02 \| Trojan | trojan tcp + tls | |
| 🇹🇼 台湾 01 \| Trojan WS | trojan ws + tls | |
| 🇰🇷 韩国 01 \| Hysteria2 | hysteria2 + salamander | obfs、obfs-password |
| 🇩🇪 德国 01 \| IPv6 | trojan | IPv6 服务器，URI 中为 `[2001:db8::10]` |
| 🇬🇧 英国 01 \| TUIC | tuic v5 | 仅 YAML；IR 支持但 M1 不做 URI 导入 |
| 🇫🇷 法国 01 \| AnyTLS | anytls | 仅 YAML |

## 建议的断言

1. `mihomo-airport-full` 和 `mihomo-proxies-only` 导入后得到 15 个节点。`mihomo-airport-full` 中的策略组、规则集和规则也应正确解析。
2. `uri-mixed` 和三种 Base64 变体导入结果**完全相同**，都是 13 个节点。
3. **交叉一致性**：`uri-mixed` 导入的 13 个节点，与 YAML 导入结果中同名的 13 个节点，在 IR 层面应该相等。这是最有价值的一条测试，能发现两个导入器对同一字段理解不一致的问题。比较时忽略 `udp`（URI 无法表达 UDP，导入器不编造）和 `extra`（键空间随来源格式不同）。
4. 节点顺序与源文件保持一致。

## uri-edge-cases 逐行预期

预期行为是建议值，实现时如需调整，请在 PR 中说明。

| 行 | 内容 | 建议预期 |
|---|---|---|
| 空行、首尾空白 | | 忽略空行，去掉首尾空白 |
| Legacy SS | 整段 base64 的旧格式 `ss://BASE64(method:pass@host:port)#name` | 正常解析，名称为 `Legacy SS` |
| 无名称的 SS | 没有 `#name` | 正常解析，名称回退为 `host:port` |
| VMess 数字端口 | JSON 中 port、aid、v 为数字，tls 为空字符串 | 正常解析，无 TLS |
| VMess 非法 base64 | `vmess://this-is-not-base64!!!` | 跳过，产生警告 |
| VLESS 无加密 | `security=none` | 正常解析，无 TLS，名称为中文 |
| `hy2://` | hysteria2 的别名 scheme，`insecure=1` | 按 hysteria2 解析，skip-cert-verify 为 true |
| 端口跳跃 | `hysteria2://...@hop.example.com:20000-30000/` | 解析为端口范围：`port: 20000`、`ports: "20000-30000"` |
| 重名节点 ×2 | 两个都叫 `Duplicate Name` | 都保留；导入器不去重，去重交给流水线 |
| `tuic://` | M1 不支持 | 跳过，产生警告（含行号和协议名） |
| `ssr://` | 不支持 | 跳过，产生警告 |
| `https://...` | 不是代理链接 | 跳过，产生警告 |
| 乱码行 | | 跳过，产生警告 |

预期结果：成功导入 8 个节点（Legacy SS、无名称 SS、VMess 数字端口、VLESS 无加密、hy2 别名、两个重名节点，以及端口跳跃节点），其余 5 行各产生一条警告。

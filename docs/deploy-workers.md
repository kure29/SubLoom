# 部署到 Cloudflare Workers

SubLoom 可以部署到你自己的 Cloudflare 账号，使用 Workers（运行代码）、D1（数据库）、KV（缓存）和 Workers Static Assets（前端页面）。免费版即可运行，但有 CPU 时间等限制，见文末"免费版的限制"。

有两种部署方式：

| | GitHub Actions（推荐） | Deploy to Cloudflare 按钮 |
|---|---|---|
| 仓库 | fork 本仓库 | 按钮在你的账号下新建一个仓库（复制，不是 fork） |
| D1、KV | 首次部署时自动创建 | 按钮流程中自动创建 |
| 升级 | 每天自动同步上游并部署（可关闭） | 需要自己把上游合并到新仓库 |
| 需要的东西 | Cloudflare API Token、Account ID | Cloudflare 账号授权 |

两种方式都**不需要**在本地安装任何工具。

---

## 方式一：GitHub Actions

### 1. Fork 仓库，启用 Actions

在 GitHub 上 fork 本仓库。打开 fork 的 **Actions** 页面，点击启用 workflow（GitHub 默认不在 fork 中运行 workflow）。

### 2. 创建 Cloudflare API Token

Cloudflare 控制台 → 右上角头像 → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**，添加以下权限（都是 **Account** 级别）：

| 权限 | 级别 | 用途 |
|---|---|---|
| Workers Scripts | Edit | 上传 Worker 和前端静态文件、Cron Triggers、启用 `workers.dev` 域名 |
| D1 | Edit | 首次部署时自动创建数据库 |
| Workers KV Storage | Edit | 首次部署时自动创建 KV 命名空间 |

**Account Resources** 选 **Include → 你要部署的那个账号**。使用 `workers.dev` 域名时不需要任何 Zone 权限；以后绑定自定义域名时，另加该域名（Zone）的 **Workers Routes: Edit**。

> 数据库迁移由 Worker 在运行时自己执行，部署时不需要额外的 D1 权限。

### 3. 设置 GitHub Secrets

在 fork 的 **Settings → Secrets and variables → Actions → New repository secret** 中添加：

- `CLOUDFLARE_API_TOKEN`：上一步创建的 Token。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 控制台 → **Workers & Pages** 页面右侧的 **Account ID**（或任意域名的 Overview 页面右下角）。

这两个值只在部署步骤中通过环境变量传给 wrangler。没有设置时，部署 workflow 直接跳过（不报错）。

### 4. 部署

在 **Actions → Deploy Workers → Run workflow** 手动运行一次。之后每次 main 分支上的 CI 通过后都会自动部署。

首次部署时 wrangler 自动创建：

- D1 数据库 `subloom`（如果账号中已有同名数据库，直接使用它）
- KV 命名空间 `subloom-blobs`

之后的部署继续使用同一个 D1 和 KV（即使配置文件中没有写 ID）。部署日志的最后会打印 Worker 的地址，形如 `https://subloom.<你的子域>.workers.dev`。

### 5. 设置 SECRET_KEY 和 ADMIN_TOKEN

这两个值是 Worker 的 **Secret**，由你自己设置，部署 workflow 不会接触它们。**请在添加订阅之前设置 `SECRET_KEY`。**

任选一种方式（两者等价）：

- **控制台**：Workers & Pages → subloom → **Settings → Variables and Secrets → Add**，类型选 **Secret**，分别添加 `SECRET_KEY` 和 `ADMIN_TOKEN`。
- **命令行**（需要本地安装 Node 并登录 wrangler）：

  ```sh
  npx wrangler secret put SECRET_KEY --name subloom
  npx wrangler secret put ADMIN_TOKEN --name subloom
  ```

生成随机值可以用 `openssl rand -base64 32`，或任意密码管理器。设置后立即生效，不需要重新部署。

**未设置时的行为与 Docker 版一致**：

- `ADMIN_TOKEN` 未设置：首次请求时自动生成管理令牌，**只打印一次**到日志。到 Workers & Pages → subloom → **Observability**（Workers Logs）中搜索 `admin token` 即可找到。数据库中只保存它的哈希。
- `SECRET_KEY` 未设置：自动生成并存入 D1。订阅链接仍会加密，但密钥与密文在同一个数据库里，数据库泄露时加密形同虚设；`/api/meta` 的 `secretKeySource` 为 `generated`，前端会提示你设置。
- **添加订阅之后再设置或更换 `SECRET_KEY`**，已保存的订阅链接将无法解密（刷新时报 `DECRYPT_FAILED`）。补救办法：先用 `/api/backup` 导出备份（明文），设置新的 `SECRET_KEY` 后再 `/api/restore`；或者逐个重新填写订阅链接。**请妥善保存 `SECRET_KEY`，丢失后无法恢复已加密的链接。**

### 6. 检查

- 打开 `https://subloom.<你的子域>.workers.dev/healthz`，应返回 `{"status":"ok"}`。
- 带上管理令牌请求 `/api/meta`：`platform` 为 `workers`，设置了 `SECRET_KEY` 时 `secretKeySource` 为 `env`。

  ```sh
  curl -H "Authorization: Bearer <管理令牌>" https://subloom.<你的子域>.workers.dev/api/meta
  ```

### 7. 其他设置（可选）

在 Workers & Pages → subloom → **Settings → Variables and Secrets** 中添加，类型选 **Text**。部署时会保留这些变量（配置中设置了 `keep_vars: true`）。

| 变量 | 说明 |
|---|---|
| `PUBLIC_URL` | 对外访问地址（如绑定了自定义域名 `https://sub.example.com`）。设置后输出链接、Surge 的 `#!MANAGED-CONFIG`、proxy-providers 地址都用它生成 |
| `TRUST_PROXY` | 为 `true` 时读取 `X-Forwarded-Proto` / `X-Forwarded-Host`。Workers 上通常不需要 |
| `CORS_ORIGINS` | 允许访问管理接口的前端来源，逗号分隔（使用官方前端或自己部署的前端时设置） |
| `ALLOW_PRIVATE_FETCH` | Workers 无法访问内网地址，保持默认即可 |

**自定义域名**：Workers & Pages → subloom → **Settings → Domains & Routes → Add → Custom domain**（域名需要托管在同一个 Cloudflare 账号）。之后建议同时设置 `PUBLIC_URL`。

### 8. 升级

fork 中的 **Sync upstream** workflow 每天检查一次上游仓库，有新提交时同步到你的 fork 并触发部署；也可以在 Actions 页面手动运行。数据库结构的变化在升级后的首次请求时自动迁移，不需要任何操作。

- 上游改动了 `.github/workflows` 中的文件时，Actions 没有权限自动同步，会失败。此时在 fork 的 GitHub 页面上点 **Sync fork → Update branch**，CI 通过后会自动部署。
- 不想自动升级：在 Actions 页面禁用 **Sync upstream**。

---

## 方式二：Deploy to Cloudflare 按钮

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kure29/SubLoom)

以 [Cloudflare 官方文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/)为准，按钮能自动完成的：

- 在你的 GitHub（或 GitLab）账号下新建一个仓库（内容复制自本仓库），并连接到 Workers Builds：之后推送到这个仓库时自动构建、部署。
- 读取仓库根目录的 `wrangler.jsonc`，**自动创建 D1 数据库和 KV 命名空间**（页面上可以修改 Worker 名和资源名），并把新资源的 ID 写入新仓库的配置。
- 读取 `.dev.vars.example`，在页面上提示填写 `ADMIN_TOKEN`、`SECRET_KEY`。**请填写 `SECRET_KEY`**（原因见上文第 5 步）。
- 构建命令和部署命令取自根 `package.json` 的 `build`、`deploy` 脚本（`pnpm build`、`wrangler deploy`）。
- D1 迁移：官方建议在部署脚本中执行；SubLoom 在首次请求时自动迁移，不需要额外步骤。

做不到、需要手动完成的：

- **升级**：新仓库不是 fork，不能使用 Sync upstream workflow。升级时在新仓库的本地克隆中执行：

  ```sh
  git remote add upstream https://github.com/kure29/SubLoom.git   # 只需一次
  git pull upstream main
  git push
  ```

  推送后 Workers Builds 自动部署。
- **事后修改 Secret**、设置 `PUBLIC_URL` 等变量、绑定自定义域名：同方式一的第 5、7 步。
- 按钮只能部署公开仓库（github.com 或 gitlab.com）。

---

## 查看日志与 CPU 时间

- **日志**：Workers & Pages → subloom → **Observability**。自动生成的管理令牌、订阅刷新失败、定时任务的结果都在这里（日志中不会出现完整的订阅链接和输出 token）。免费版每天 20 万条日志，保留 3 天。
- **CPU 时间**：Workers 运行时里的计时函数在同步执行期间不会前进（防止计时攻击），代码中无法测量 CPU 时间，只能在控制台查看：
  - **Metrics** 页面的 **CPU Time per execution** 图表：按分位数展示一段时间内的 CPU 时间。
  - **Observability** 中每次请求的调用日志（Invocation Log）记录了该次请求的 **CPU Time** 和 **Wall Time**；在 Query Builder 中按请求路径过滤，对 CPU Time 取中位数、P90 等。
  - 超出限制的请求，结果（outcome）为 `exceededCpu`，客户端收到错误 1102。
- **500 节点压测**：在仓库根目录执行 `pnpm install && pnpm build`，然后

  ```sh
  SUBLOOM_URL=https://subloom.<你的子域>.workers.dev SUBLOOM_ADMIN_TOKEN=<管理令牌> node scripts/workers-perf.mjs
  ```

  脚本会创建一个 500 节点的本地订阅，依次请求刷新（解析）、preview（流水线 + 导出 mihomo / Surge）和输出链接（缓存命中），各 5 次，最后删除创建的数据，并打印请求的时间范围。之后按上面的方法在控制台查看各类请求的 CPU 时间。

## 免费版的限制

| 限制 | 影响 |
|---|---|
| 每个请求（包括定时任务）CPU 时间 10ms | 解析大订阅（几百个节点）和首次生成配置可能超限；生成好的配置有缓存，客户端更新时通常命中缓存。超限时可升级 Workers 付费计划，或改用 Docker 部署。实测数据见 PLAN.md 5.6 |
| KV 每天 1000 次写入 | 每次刷新订阅写 2 个 key，配置变化时各写 1 个。订阅很多、刷新间隔很短时可能超出 |
| KV 写入最终一致 | 刷新后其他地区最多约 60 秒才能看到新节点 |
| 出口 IP 属于 Cloudflare | 部分机场会拦截来自 Cloudflare 的请求（刷新时报 `FETCH_FAILED`），这种情况请改用 Docker 部署 |
| 无法访问内网地址 | 局域网内的订阅只能用 Docker 部署拉取 |

## 本地开发

```sh
pnpm install
pnpm build                                 # 构建前端静态文件和各个包
cp .dev.vars.example .dev.vars             # 可选：填写本地使用的 ADMIN_TOKEN、SECRET_KEY
pnpm --filter @subloom/worker dev          # wrangler dev，本地的 D1、KV 自动创建
```

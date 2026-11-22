# dsh-skills-sync

DeepSeek Harness 技能同步插件：把自建技能归档到一个 git 仓库，并在多台电脑之间同步。

提供三件东西：

- **设置页面**：在 DSH 设置里配置仓库、token、私有/公开与存档目录。
- **悬浮按钮**：右下角常驻，一键拉取 / 推送。
- **技能存档纪律**：向 Agent 注入固定指令，要求自建技能写入指定目录，不要散落在各工作区。

---

## 安装

### 方式一：从本地目录安装（开发与自用）

```text
plugin_manager  action: install_bundle  target: <本仓库的绝对路径>
```

或使用 GUI：**Plugins > Add plugin** 选择本目录。

### 方式二：在其他电脑上安装

```powershell
# 1. 克隆仓库到你喜欢的位置
git clone https://github.com/crsm5192/dsh-skills-sync.git C:\dsh-plugins\dsh-skills-sync

# 2. 安装
#    在 DSH 中使用 plugin_manager，target 指向克隆到的目录
```

安装后**刷新 DSH 页面**，右下角出现悬浮按钮，设置里出现「技能同步」页面。

---

## 配置

打开 **设置 > 技能同步**。

| 字段 | 说明 |
|---|---|
| 技能存档目录 | 自建技能的统一存储位置。留空则使用 DSH 用户级技能目录（`~/.agents/skills`）。 |
| 仓库地址 | 形如 `https://github.com/<owner>/<repo>.git`。 |
| 分支 | 默认 `main`。 |
| 用户名 | GitHub / Gitee 用户名，用于 token 认证。 |
| 访问令牌 | `ghp_...` 或 Gitee 私人令牌。保存在 DSH 凭据库，不写入配置文件。 |
| 仓库设为私有 | 创建仓库时使用私有可见性。 |
| 允许自动创建 | 仓库不存在时允许「创建仓库」按钮调用 API 创建。 |
| 注入技能存档纪律 | 向 Agent 注入存档纪律说明。 |

页面上的按钮：

- **保存**：写入配置；token 单独存进凭据库。
- **测试连接**：验证仓库地址与 token 是否可用，并报告仓库是否存在。
- **创建仓库**：在 GitHub / Gitee 上创建该仓库。
- **初始化本地仓库**：对存档目录执行 `git init`、设置 remote、首次提交并推送。

### 新机器自动引导（v1.1+）

新机器上**不需要手动创建目录或初始化 git**。只要配置里填了「仓库地址」，第一次点「拉取」或自动同步时插件会自动完成：

1. 创建存档目录（如 `C:\Users\<你>\.agents\skills`，不存在就建）
2. `git init`
3. `git remote add origin <仓库地址>`
4. `git fetch origin`
5. `git checkout -B <分支> origin/<分支>`（远端还没有提交时跳过，等首次推送）

所以全新机器上填好「仓库地址」+「访问令牌」→ 点「拉取」即可，不会再出现
`fatal: not a git repository (or any of the parent directories): .git`。

> 私有仓库必须先填访问令牌，否则第 4 步会因无法认证而失败（报错显示 `could not read Username`）。

### 令牌权限

GitHub 细粒度令牌需要：

- `Repository access`：选择目标仓库
- `Contents`：Read and write
- `Administration`：Read and write（仅创建仓库时需要）

---

## 使用

### 日常同步

右下角浮动按钮点击展开，两个动作：

- **拉取**：`git fetch --all --prune` 后 `git pull --rebase --autostash`
- **推送**：`git add -A`，有改动则自动提交，再推送

状态圆点含义：

| 颜色 | 含义 |
|---|---|
| 🟢 绿 | 干净且与上游同步 |
| 🟡 黄 | 有未提交改动 |
| 🔵 蓝 | 本地有未推送提交 |
| 🟣 紫 | 上游有未拉取提交 |

### 插件自身更新

设置页最下方有「插件更新」区块：

- 显示当前已安装版本、所在分支、落后远端多少个提交
- 点「检查并更新插件」→ 插件对自己的安装目录执行 `git fetch` + `git merge --ff-only`
- **有未提交改动时会拒绝更新**，避免覆盖本地修改
- 安装目录不是 git 检出（例如从 npm 装的包）时不提供更新按钮，只显示版本

> ⚠️ 更新完成后必须**重启 DSH**（或禁用再启用插件）**并刷新页面**，否则仍在运行旧代码。

### 技能存档纪律

启用后，每个新会话的系统提示都会带上这段规则，指向你配置的存档目录：

```text
## 技能存档纪律

自建技能（SKILL.md 及其 references/、scripts/、assets/）一律创建并保存在 <存档目录> 下，不要散落在各工作区。

规则：
- 新建技能时直接写入 <存档目录>\<kebab-case-name>\SKILL.md，frontmatter 必须含 name 与 description。
- 修改已有技能时编辑同一目录下的文件，不要复制到工作区另建副本。
- 若发现工作区内存在技能的游离副本（例如 <workspace>/skills/），提示用户迁入上述目录，不要就地继续修改。
- 需要跨机同步时由用户通过「技能同步」界面执行拉取或推送，不要自行改写 git 远程地址。
```

---

## HTTP 端点

插件在 Host 上注册以下路由，前缀由 `routePrefix` 配置（默认 `/api/skills-sync`）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/state` | 分支、未提交数、ahead/behind、最近提交、远程地址 |
| POST | `/pull` | 拉取远程更新 |
| POST | `/push` | 提交并推送本地改动 |
| GET | `/config` | 读取当前配置（不含 token 明文） |
| POST | `/config` | 保存配置；token 写入凭据库 |
| POST | `/test` | 测试仓库地址与 token |
| POST | `/create-repo` | 在托管平台创建仓库 |
| POST | `/init` | 初始化本地仓库并首次推送 |
| GET | `/update/status` | 检查插件自身是否有新版本（是否为 git 检出、落后几个提交） |
| POST | `/update` | 对插件自身执行 `fetch` + `merge --ff-only`（有未提交改动时拒绝） |

---

## 安全说明

- token 只写入 DSH 凭据库（记录键 `skills-sync/git-token`），不进入配置文件、不进入会话日志、不回显给界面。
- 推送时按需构造带凭据的远程 URL，仅在子进程环境内使用，不落盘。
- 所有 git 子进程以 `GIT_TERMINAL_PROMPT=0` 运行，避免卡在交互式口令输入。
- 本插件不读取、不解密、不打印任何口令文件内容。

---

## 已知限制

- 两台电脑同时改同一文件时，`pull --rebase` 会产生冲突，需要手动处理（`git rebase --continue` 或 `git rebase --abort`）。
- 自动创建仓库目前支持 GitHub 与 Gitee；其他托管平台需要手动建库。
- 修改配置后插件会重启，页面需要刷新才能看到新值。
- 「初始化本地仓库」对已存在 `origin` 的目录会改写 remote URL。
- 引导流程对**已有内容但非 git 仓库**的目录会执行 `git init`；如果该目录里已有同名技能文件，`checkout -B` 可能因"untracked files would be overwritten"中止，此时先手工移走或提交这些文件再重试。
- **自更新**仅适用于通过克隆源码安装的插件（symlink 或 copy），不适用于从 npm 安装的包。更新后必须重启 DSH 或禁用再启用插件，新代码才会生效。
- **凭据注入历史问题**：v1.0–v1.2 版本在同步时会重复向远程 URL 添加 token，导致 URL 中出现多个 `@`（如 `user:tok@user:tok@host`），git 误判为端口号而失败。**v1.3+ 会自动检测并修复已损坏的 URL**，无需手动干预。

---

## 目录结构

```text
dsh-skills-sync/
├── package.json        插件清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml    Loader 行（config 留空，由设置页面写入）
├── index.js            Host：git 操作、配置、凭据、系统提示
├── client.js           浏览器：悬浮按钮 + 设置页面
├── icon.svg            插件图标
├── locale/
│   ├── en.json
│   └── zh.json
└── docs/
    └── DETAIL.md       插件详情页
```

---

## 许可

本仓库未附许可文件。如需他人复用，请自行添加合适的许可证。

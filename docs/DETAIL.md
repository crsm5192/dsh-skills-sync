# @local/dsh-skills-sync

DeepSeek Harness 技能同步插件：Settings 配置页面 + 浮动按钮 + 技能存档纪律。

## 安装

使用 `plugin_manager` 安装本地目录：

```bash
plugin_manager action:install_bundle target:/绝对路径到 dsh-skills-sync 目录
```

或从 GUI 的 **Plugins > Add plugin** 选择该目录。

## 功能

### Settings 配置页面

访问路径：**设置 > 技能同步**

可配置项：

- **技能存档目录**：自建技能的统一存储位置（默认自动检测 DSH 用户级技能目录）
- **仓库地址**：Git 远程仓库 URL，格式 `https://github.com/owner/repo.git`
- **分支**：默认 `main`
- **用户名**：GitHub/Gitee 用户名（用于 token 认证）
- **访问令牌**：`ghp_...` 或 Gitee 私人令牌（保存在凭据库，不写入配置文件）
- **仓库设为私有**：勾选则自动创建私有仓库
- **允许自动创建**：仓库不存在时自动调用 API 创建
- **注入技能存档纪律**：Agent 会话开始时收到“自建技能必须归档到此目录”的指令

### 浮动按钮

- **拉取**：`git pull --rebase --autostash`
- **推送**：自动 commit + `git push origin main`
- **状态指示器**：
  - 🟢 绿色 = 干净且同步
  - 🟡 黄色 = 有未提交改动
  - 🔵 蓝色 = 本地有未推送提交
  - 🟣 紫色 = 上游有未拉取提交

### Discipline 系统提示

当启用「注入技能存档纪律」后，每次 Agent 会话都会收到如下固定指令：

```text
## 技能存档纪律

自建技能（SKILL.md 及其 references/、scripts/、assets/）一律创建并保存到指定目录，不要散落在各工作区。

规则：
- 新建技能时直接写入该目录下，frontmatter 必须含 name 与 description。
- 修改已有技能时编辑同一目录下的文件，不要复制到工作区另建副本。
- 若发现工作区内存在技能的游离副本，提示用户迁入上述目录，不要就地继续修改。
- 需要跨机同步时由用户通过「技能同步」界面执行拉取或推送，不要自行改写 git 远程地址。
```

## 安全说明

- 所有命令在后台运行，不输出明文密码
- Token 仅存储在 DSH 凭据库，不会出现在配置文件或会话日志中
- 凭据由 Windows 凭据管理器缓存，不会进入会话上下文

## 验证

1. 安装后刷新页面，右下角应出现悬浮按钮
2. 点击按钮，确认状态显示正确（分支、未提交数、ahead/behind）
3. 测试拉取：确保能从 GitHub 获取最新代码
4. 测试推送：修改任意技能文件后点击推送，确认能 commit+push

## 多机同步

**上班机器**：修改技能后，点击浮动按钮 **推送**  
**回家机器**：打开 DSH 前，点击浮动按钮 **拉取**

或使用 PowerShell 脚本 `sync.ps1`：
```powershell
cd ~/.agents/skills
.\sync.ps1 -Mode push   # 上班
.\sync.ps1 -Mode pull   # 回家
```

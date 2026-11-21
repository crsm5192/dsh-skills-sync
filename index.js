/**
 * Skills Sync — Host plugin.
 *
 * Responsibilities:
 *   1. Serve the floating-button RPCs (pull / push / state).
 *   2. Serve the Settings page RPCs (read config, save config, test connection,
 *      create the remote repository when it does not exist).
 *   3. Keep the git token in the credential store, never in configuration.
 *   4. Contribute a system-prompt section that tells the agent where
 *      self-authored skills must be archived.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'skills-sync'

/** Services this plugin needs; it stays inactive when one is absent. */
export const inject = ['webServer']

/** Credential record key holding the git access token. */
const CREDENTIAL_KEY = 'skills-sync/git-token'

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const str = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback)
  return {
    repoPath: str(input.repoPath, ''),
    remoteUrl: str(input.remoteUrl, ''),
    branch: str(input.branch, 'main'),
    provider: str(input.provider, 'github'),
    username: str(input.username, ''),
    private: input.private !== false,
    autoCreateRepo: input.autoCreateRepo !== false,
    routePrefix: str(input.routePrefix, '/api/skills-sync'),
    discipline: input.discipline !== false,
    autoSync: input.autoSync !== false,
    syncInterval: typeof input.syncInterval === 'number' && input.syncInterval >= 60 ? input.syncInterval : 300, // 默认 5 分钟
  }
}

/** Run one git command in the repository and never throw. */
async function git(repoPath, args, extraEnv) {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', repoPath, ...args], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        ...(extraEnv ?? {}),
      },
    })
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === 'string' ? error.stdout.trim() : '',
      stderr: typeof error.stderr === 'string' ? error.stderr.trim() : '',
      message: error instanceof Error ? error.message : String(error),
      code: typeof error.code === 'number' ? error.code : undefined,
    }
  }
}

/** Read the working-tree state the UI needs. */
async function readState(repoPath, branch) {
  const status = await git(repoPath, ['status', '--porcelain'])
  const dirty = status.ok ? status.stdout.split('\n').filter((line) => line.length > 0) : []

  const revParse = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const current = revParse.ok ? revParse.stdout : ''

  let behind = 0
  let ahead = 0
  const upstream = await git(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (upstream.ok && upstream.stdout) {
    const counts = await git(repoPath, ['rev-list', '--left-right', '--count', `@{u}...HEAD`])
    if (counts.ok && counts.stdout) {
      const [left, right] = counts.stdout.split(/\s+/)
      behind = Number.parseInt(left ?? '0', 10) || 0
      ahead = Number.parseInt(right ?? '0', 10) || 0
    }
  }

  const last = await git(repoPath, ['log', '-1', '--format=%h %s'])
  const remote = await git(repoPath, ['remote', 'get-url', 'origin'])

  return {
    branch: current || branch,
    dirtyCount: dirty.length,
    dirtyFiles: dirty.slice(0, 20),
    ahead,
    behind,
    lastCommit: last.ok ? last.stdout : '',
    remoteUrl: remote.ok ? remote.stdout : '',
    hasUpstream: upstream.ok && upstream.stdout.length > 0,
  }
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/** Parse `https://github.com/owner/name(.git)` into its parts. */
function parseRemote(url) {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!match) return undefined
  const [, host, owner, repo] = match
  return { host, owner, repo }
}

/** Ask the hosting API whether the repository exists and is reachable. */
async function probeRepo(parsed, token, username) {
  if (!parsed) return { ok: false, reason: '仓库地址格式无法识别' }
  const { host, owner, repo } = parsed
  const apiBase = host.includes('github')
    ? `https://api.${host}`
    : host.includes('gitee')
      ? 'https://gitee.com/api/v5'
      : `https://${host}/api/v4`

  const headers = { accept: 'application/json', 'user-agent': 'dsh-skills-sync' }
  if (token) {
    if (host.includes('gitee')) headers.authorization = `token ${token}`
    else headers.authorization = `Bearer ${token}`
  }

  const url = host.includes('gitee')
    ? `${apiBase}/repos/${owner}/${repo}`
    : host.includes('github')
      ? `${apiBase}/repos/${owner}/${repo}`
      : `${apiBase}/projects/${encodeURIComponent(`${owner}/${repo}`)}`

  try {
    const response = await fetch(url, { headers })
    if (response.status === 200) {
      const data = await response.json()
      return {
        ok: true,
        exists: true,
        private: Boolean(data.private ?? data.visibility === 'private'),
        defaultBranch: data.default_branch ?? data.default_branch ?? 'main',
      }
    }
    if (response.status === 404) return { ok: true, exists: false }
    return { ok: false, reason: `HTTP ${response.status}`, status: response.status }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Create the repository on the hosting service. */
async function createRepo(parsed, token, isPrivate, description) {
  if (!parsed) return { ok: false, reason: '仓库地址格式无法识别' }
  const { host, owner, repo } = parsed

  if (host.includes('github')) {
    // The repository owner may be the authenticated user or an organisation.
    const me = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    })
    if (!me.ok) return { ok: false, reason: `无法读取账号信息（HTTP ${me.status}）` }
    const login = (await me.json()).login
    const endpoint = login === owner ? 'https://api.github.com/user/repos' : `https://api.github.com/orgs/${owner}/repos`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: repo, private: isPrivate, description }),
    })
    if (!response.ok) {
      const text = await response.text()
      return { ok: false, reason: `HTTP ${response.status}: ${text.slice(0, 300)}` }
    }
    const data = await response.json()
    return { ok: true, url: data.html_url }
  }

  if (host.includes('gitee')) {
    const response = await fetch(`https://gitee.com/api/v5/user/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        access_token: token,
        name: repo,
        private: isPrivate,
        description,
        auto_init: false,
      }),
    })
    if (!response.ok) {
      const text = await response.text()
      return { ok: false, reason: `HTTP ${response.status}: ${text.slice(0, 300)}` }
    }
    const data = await response.json()
    return { ok: true, url: data.html_url }
  }

  return { ok: false, reason: `暂不支持自动创建 ${host} 上的仓库` }
}

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const base = cfg.routePrefix.replace(/\/+$/, '')
  const disposers = []

  // ── auto-sync task ──────────────────────────────────────────────────────

  let lastSyncTime = null
  let nextSyncTime = Date.now() + (cfg.syncInterval * 1000)
  let syncTaskId = null

  /** Perform a single sync cycle: fetch + pull if needed */
  async function performSync(reason = 'auto') {
    try {
      // Everything that can throw belongs inside the try, including the helper
      // lookup: this function is called without await, so a synchronous throw
      // would become a rejected promise nobody handles.
      const path = repoPath()
      await readToken()

      ctx.logger.info(`skills-sync: starting ${reason} sync at ${new Date().toISOString()}`)

      // Fetch latest from all remotes
      const fetch = await git(path, ['fetch', '--all', '--prune'])
      if (!fetch.ok) {
        ctx.logger.warn(`skills-sync: fetch failed: ${fetch.stderr}`)
        return { ok: false, reason: 'fetch', ...fetch }
      }

      // Check if we need to pull (only if upstream exists and differs)
      const upstream = await git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      if (upstream.ok && upstream.stdout.length > 0) {
        const diff = await git(path, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
        if (diff.ok && diff.stdout) {
          const [behind] = diff.stdout.split(/\s+/).map(Number.parseInt)

          // Only pull if there are behind commits (remote has new changes)
          if (behind > 0) {
            const pull = await git(path, ['pull', '--rebase', '--autostash'])
            if (!pull.ok) {
              ctx.logger.warn(`skills-sync: pull failed: ${pull.stderr}`)
              return { ok: false, reason: 'pull', ...pull }
            }
          }
        }
      }

      lastSyncTime = Date.now()
      nextSyncTime = Date.now() + (cfg.syncInterval * 1000)

      ctx.logger.info(`skills-sync: ${reason} sync completed successfully`)
      return { ok: true, reason, lastSyncTime, nextSyncTime }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.error(`skills-sync: ${reason} sync error: ${message}`)
      return { ok: false, reason, message }
    }
  }

  /** Start the periodic sync task */
  function startSyncTask() {
    if (syncTaskId) clearInterval(syncTaskId)

    syncTaskId = setInterval(() => {
      if (!cfg.autoSync) {
        nextSyncTime = Date.now() + (cfg.syncInterval * 1000)
        return
      }
      // Never leave the promise unhandled: an unhandled rejection terminates
      // the Host process.
      void performSync('scheduled').catch((error) => {
        ctx.logger.warn(`skills-sync: scheduled sync rejected: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, cfg.syncInterval * 1000)

    // Do not keep the process alive just for this timer.
    syncTaskId.unref?.()

    void performSync('startup').catch((error) => {
      ctx.logger.warn(`skills-sync: startup sync rejected: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  
  /** Stop the periodic sync task */
  function stopSyncTask() {
    if (syncTaskId) {
      clearInterval(syncTaskId)
      syncTaskId = null
    }
  }
  
  // Stop sync task when plugin deactivates. The task itself is started further
  // down, after the helpers it calls have been initialized.
  disposers.push(stopSyncTask)

  /**
   * The effective repository path: the configured one, or the DSH agents home
   * skills directory when the user left it empty.
   */
  const repoPath = () => {
    if (cfg.repoPath) return cfg.repoPath
    const home = process.env.DSH_AGENTS_HOME || `${process.env.USERPROFILE || process.env.HOME || '.'}\\.agents`
    return `${home}\\skills`
  }

  /** Read the token from the credential store; never from configuration. */
  const readToken = async () => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return ''
    try {
      const record = await credentials.readRecord(CREDENTIAL_KEY)
      const payload = record?.payload
      if (payload && typeof payload.token === 'string') return payload.token
    } catch {
      /* treat an unreadable record as absent */
    }
    return ''
  }

  /** Build an authenticated remote URL without exposing the token to the UI. */
  const authedRemote = (url, token, username) => {
    const parsed = parseRemote(url)
    if (!parsed || !token) return url
    const user = username || parsed.owner
    return `https://${encodeURIComponent(user)}:${encodeURIComponent(token)}@${parsed.host}/${parsed.owner}/${parsed.repo}.git`
  }

  // ── start the periodic sync task ─────────────────────────────────────────
  // Placement matters: `performSync` reads `repoPath` and `readToken`, which are
  // `const` initializers above. Calling this before they are initialized throws
  // a TDZ ReferenceError inside an async function, which escapes as an unhandled
  // rejection and terminates the Host process on startup.
  startSyncTask()

  // ── floating-button RPCs ─────────────────────────────────────────────────

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${base}/state`,
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      const state = await readState(repoPath(), cfg.branch)
      json(res, 200, {
        ok: true,
        state: {
          ...state,
          // Auto-sync status
          autoSyncEnabled: cfg.autoSync,
          syncIntervalSeconds: cfg.syncInterval,
          lastSyncTime: lastSyncTime ? new Date(lastSyncTime).toISOString() : null,
          nextSyncTime: cfg.autoSync ? new Date(nextSyncTime).toISOString() : null,
          lastSyncAgo: lastSyncTime ? Math.floor((Date.now() - lastSyncTime) / 1000) : null,
          nextSyncIn: cfg.autoSync ? Math.max(0, Math.floor((nextSyncTime - Date.now()) / 1000)) : null,
        },
      })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${base}/pull`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      await readBody(req)
      const path = repoPath()
      const token = await readToken()

      if (token) {
        const url = await git(path, ['remote', 'get-url', 'origin'])
        if (url.ok) {
          await git(path, ['remote', 'set-url', 'origin', authedRemote(url.stdout, token, cfg.username)])
        }
      }

      const fetch = await git(path, ['fetch', '--all', '--prune'])
      if (!fetch.ok) {
        json(res, 500, { ok: false, step: 'fetch', ...fetch, state: await readState(path, cfg.branch) })
        return
      }
      const pull = await git(path, ['pull', '--rebase', '--autostash'])
      json(res, pull.ok ? 200 : 500, { ok: pull.ok, step: 'pull', ...pull, state: await readState(path, cfg.branch) })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${base}/push`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      await readBody(req)
      const path = repoPath()
      const token = await readToken()

      const add = await git(path, ['add', '-A'])
      if (!add.ok) {
        json(res, 500, { ok: false, step: 'add', ...add, state: await readState(path, cfg.branch) })
        return
      }

      const status = await git(path, ['status', '--porcelain'])
      const dirty = status.ok ? status.stdout.trim() : ''
      let committed = false
      if (dirty.length > 0) {
        const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
        const commit = await git(path, ['commit', '-m', `chore: sync skills ${stamp}`])
        if (!commit.ok) {
          json(res, 500, { ok: false, step: 'commit', ...commit, state: await readState(path, cfg.branch) })
          return
        }
        committed = true
      }

      let push
      if (token && cfg.remoteUrl) {
        push = await git(path, ['push', authedRemote(cfg.remoteUrl, token, cfg.username), `HEAD:${cfg.branch}`])
      } else {
        push = await git(path, ['push'])
      }
      json(res, push.ok ? 200 : 500, {
        ok: push.ok,
        step: 'push',
        committed,
        ...push,
        state: await readState(path, cfg.branch),
      })
    },
  }))

  // ── settings page RPCs ───────────────────────────────────────────────────

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${base}/config`,
    async handler(req, res) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const credentials = ctx.get('credentials')
        let tokenConfigured = false
        if (credentials !== undefined) {
          try {
            const described = await credentials.describeRecord(CREDENTIAL_KEY)
            tokenConfigured = Boolean(described?.configured)
          } catch {
            /* absent */
          }
        }
        const entry = ctx.fiber?.entry
        const current = entry?.options?.config ?? {}
        json(res, 200, {
          ok: true,
          config: { ...normalizeConfig(current), tokenConfigured },
          defaults: {
            repoPath: repoPath(),
          },
        })
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, HEAD, POST' })
        res.end()
        return
      }

      const body = await readBody(req)
      const entry = ctx.fiber?.entry
      const editor = ctx.get('configEditor')
      if (entry === undefined || editor === undefined) {
        json(res, 500, { ok: false, reason: '当前 profile 不支持保存配置' })
        return
      }

      const next = {
        repoPath: typeof body.repoPath === 'string' ? body.repoPath : cfg.repoPath,
        remoteUrl: typeof body.remoteUrl === 'string' ? body.remoteUrl : cfg.remoteUrl,
        branch: typeof body.branch === 'string' && body.branch ? body.branch : cfg.branch,
        provider: typeof body.provider === 'string' ? body.provider : cfg.provider,
        username: typeof body.username === 'string' ? body.username : cfg.username,
        private: typeof body.private === 'boolean' ? body.private : cfg.private,
        autoCreateRepo: typeof body.autoCreateRepo === 'boolean' ? body.autoCreateRepo : cfg.autoCreateRepo,
        discipline: typeof body.discipline === 'boolean' ? body.discipline : cfg.discipline,
        autoSync: typeof body.autoSync === 'boolean' ? body.autoSync : cfg.autoSync,
        syncInterval: typeof body.syncInterval === 'number' && body.syncInterval >= 60 
          ? body.syncInterval 
          : cfg.syncInterval,
      }

      // The token goes to the credential store, never into configuration.
      if (typeof body.token === 'string' && body.token.length > 0) {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) {
          json(res, 500, { ok: false, reason: '凭据服务不可用，token 未保存' })
          return
        }
        await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({
          kind: 'grant',
          payload: { token: body.token },
        }))
      }

      try {
        await editor.edit(entry, (currentValue) => ({ ...currentValue, ...next }))
      } catch (error) {
        json(res, 500, {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        })
        return
      }

      json(res, 200, { ok: true })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${base}/test`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      const body = await readBody(req)
      const url = typeof body.remoteUrl === 'string' && body.remoteUrl ? body.remoteUrl : cfg.remoteUrl
      const token = typeof body.token === 'string' && body.token ? body.token : await readToken()
      const username = typeof body.username === 'string' ? body.username : cfg.username

      const parsed = parseRemote(url)
      if (!parsed) {
        json(res, 200, { ok: false, reason: '仓库地址格式无法识别，应为 https://github.com/owner/repo' })
        return
      }
      if (!token) {
        json(res, 200, { ok: false, reason: '未提供访问 token' })
        return
      }
      const probe = await probeRepo(parsed, token, username)
      json(res, 200, { ...probe, parsed })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${base}/create-repo`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      const body = await readBody(req)
      const url = typeof body.remoteUrl === 'string' && body.remoteUrl ? body.remoteUrl : cfg.remoteUrl
      const token = typeof body.token === 'string' && body.token ? body.token : await readToken()
      const isPrivate = typeof body.private === 'boolean' ? body.private : cfg.private
      const parsed = parseRemote(url)

      if (!parsed) {
        json(res, 200, { ok: false, reason: '仓库地址格式无法识别' })
        return
      }
      if (!token) {
        json(res, 200, { ok: false, reason: '未提供访问 token' })
        return
      }

      const result = await createRepo(parsed, token, isPrivate, 'DSH 自建技能存档')
      json(res, 200, result)
    },
  }))

  // ── initialise a fresh repository ────────────────────────────────────────

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${base}/init`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      const body = await readBody(req)
      const path = typeof body.repoPath === 'string' && body.repoPath ? body.repoPath : repoPath()
      const url = typeof body.remoteUrl === 'string' && body.remoteUrl ? body.remoteUrl : cfg.remoteUrl
      const branch = typeof body.branch === 'string' && body.branch ? body.branch : cfg.branch
      const token = typeof body.token === 'string' && body.token ? body.token : await readToken()

      const steps = []
      const hasGit = await git(path, ['rev-parse', '--git-dir'])
      if (!hasGit.ok) {
        const init = await git(path, ['init', '--initial-branch', branch])
        steps.push({ step: 'init', ...init })
        if (!init.ok) {
          json(res, 500, { ok: false, steps })
          return
        }
      }

      const remotes = await git(path, ['remote', 'get-url', 'origin'])
      if (remotes.ok) {
        await git(path, ['remote', 'set-url', 'origin', url])
        steps.push({ step: 'remote-update', ok: true })
      } else {
        const add = await git(path, ['remote', 'add', 'origin', url])
        steps.push({ step: 'remote-add', ...add })
      }

      const addAll = await git(path, ['add', '-A'])
      steps.push({ step: 'add', ...addAll })

      const status = await git(path, ['status', '--porcelain'])
      if (status.ok && status.stdout.trim().length > 0) {
        const commit = await git(path, ['commit', '-m', 'chore: initial skills archive'])
        steps.push({ step: 'commit', ...commit })
      }

      const push = token
        ? await git(path, ['push', '-u', authedRemote(url, token, cfg.username), `HEAD:${branch}`])
        : await git(path, ['push', '-u', 'origin', `HEAD:${branch}`])
      steps.push({ step: 'push', ...push })

      json(res, push.ok ? 200 : 500, { ok: push.ok, steps, state: await readState(path, branch) })
    },
  }))

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* already disposed */ }
    }
  })

  // ── discipline: where self-authored skills must be archived ──────────────

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined && cfg.discipline) {
    const target = repoPath()
    ctx.effect(() => systemPrompt.section({
      name: 'skills-sync:archive-discipline',
      order: 9000,
      text: [
        '## 技能存档纪律',
        '',
        `自建技能（SKILL.md 及其 references/、scripts/、assets/）一律创建并保存在 \`${target}\` 下，不要散落在各工作区。`,
        '',
        '规则：',
        `- 新建技能时直接写入 \`${target}\\<kebab-case-name>\\SKILL.md\`，frontmatter 必须含 name 与 description。`,
        '- 修改已有技能时编辑同一目录下的文件，不要复制到工作区另建副本。',
        '- 若发现工作区内存在技能的游离副本（例如 <workspace>/skills/），提示用户迁入上述目录，不要就地继续修改。',
        '- 需要跨机同步时由用户通过「技能同步」界面执行拉取或推送，不要自行改写 git 远程地址。',
      ].join('\n'),
    }))
  }

  ctx.logger.info(`skills-sync: ${base} → ${repoPath()} (${cfg.branch})`)
}

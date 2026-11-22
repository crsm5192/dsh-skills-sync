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
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

/** Absolute directory of this plugin, used by the self-update endpoint. */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

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
    remoteUrl: remote.ok ? stripCredentials(remote.stdout) : '',
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

/**
 * Parse `https://github.com/owner/name(.git)` into its parts.
 *
 * Tolerates URLs that already carry credentials, including the malformed
 * `user:tok@user:tok@host` form produced when a token is injected twice: the
 * host is whatever follows the LAST `@`, so repeated credentials collapse
 * instead of being mistaken for a port.
 */
function parseRemote(url) {
  const trimmed = String(url ?? '').trim()
  const scheme = /^https?:\/\/(.+)$/.exec(trimmed)
  if (!scheme) return undefined
  const rest = scheme[1]
  const slash = rest.indexOf('/')
  if (slash < 0) return undefined
  let authority = rest.slice(0, slash)
  const pathPart = rest.slice(slash + 1)
  const at = authority.lastIndexOf('@')
  if (at >= 0) authority = authority.slice(at + 1)
  // Drop a trailing port so `host:443` compares equal to `host`.
  authority = authority.replace(/:\d+$/, '')
  const segments = pathPart.split('/').filter(Boolean)
  if (segments.length < 2) return undefined
  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/, '')
  if (!authority || !owner || !repo) return undefined
  return { host: authority, owner, repo }
}

/** Build an authenticated remote URL without exposing the token to the UI. */
function authedRemote(url, token, username) {
  const parsed = parseRemote(url)
  if (!parsed || !token) return url
  const user = username || parsed.owner
  return `https://${encodeURIComponent(user)}:${encodeURIComponent(token)}@${parsed.host}/${parsed.owner}/${parsed.repo}.git`
}

/** Strip credentials from a remote URL, for display and logging. */
function stripCredentials(url) {
  const parsed = parseRemote(url)
  if (!parsed) return String(url ?? '')
  return `https://${parsed.host}/${parsed.owner}/${parsed.repo}.git`
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
      const token = await readToken()

      ctx.logger.info(`skills-sync: starting ${reason} sync at ${new Date().toISOString()}`)

      // Make sure the repository exists (creates the directory and initialises
      // git when this is a fresh machine). Without this the first `git fetch`
      // fails with "not a git repository" on every new install.
      if (cfg.remoteUrl) {
        const ensured = await ensureRepo(path, cfg, token)
        if (!ensured.ok) {
          ctx.logger.warn(`skills-sync: repository bootstrap failed: ${JSON.stringify(ensured.steps)}`)
          return { ok: false, reason: 'bootstrap', steps: ensured.steps }
        }
      } else {
        // No remote configured yet: still make sure the directory exists so the
        // agent's archive discipline points at a real path.
        try {
          await fs.mkdir(path, { recursive: true })
        } catch {
          /* a pre-existing directory is fine */
        }
      }

      // Heal a malformed remote URL. A previous version re-injected the token on
      // every sync, producing `user:tok@user:tok@host`, which git parses as a
      // port and rejects. Rewrite it from the configured remote whenever the
      // stored URL disagrees with what we would build now.
      if (cfg.remoteUrl) {
        const currentUrl = await git(path, ['remote', 'get-url', 'origin'])
        const intended = token ? authedRemote(cfg.remoteUrl, token, cfg.username) : cfg.remoteUrl
        if (currentUrl.ok && currentUrl.stdout && currentUrl.stdout !== intended) {
          const atCount = (currentUrl.stdout.match(/@/g) ?? []).length
          if (atCount > 1 || parseRemote(currentUrl.stdout)?.host !== parseRemote(intended)?.host) {
            const fixed = await git(path, ['remote', 'set-url', 'origin', intended])
            ctx.logger.warn(
              `skills-sync: healed malformed remote URL (${atCount} '@') -> ${stripCredentials(intended)}${fixed.ok ? '' : ` (set-url failed: ${fixed.stderr})`}`,
            )
          }
        }
      }

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

  /**
   * Ensure a git repository exists at `path`:
   * - Create directory if missing
   * - If not a git repo: init + add remote + fetch origin/<branch>
   * Returns { ok, steps[] }.
   */
  async function ensureRepo(path, cfg, token) {
    const steps = []
    // 1. create directory if missing
    try {
      await fs.mkdir(path, { recursive: true })
      steps.push({ step: 'mkdir', ok: true, created: true })
    } catch (err) {
      // mkdir failure is non-fatal; continue to see if repo already exists
      steps.push({ step: 'mkdir', ok: false, error: err.message })
    }
    // 2. check if it's a git repo
    const hasGit = await git(path, ['rev-parse', '--git-dir'])
    if (hasGit.ok) {
      // Already a repo. Only touch the remote when it is missing or when a
      // token must be injected: rewriting an identical URL on every sync just
      // churns `.git/config` and produces noise in the diff.
      const currentUrl = await git(path, ['remote', 'get-url', 'origin'])
      const authed = token ? authedRemote(cfg.remoteUrl, token, cfg.username) : cfg.remoteUrl
      const missing = !currentUrl.ok
      const needsToken = Boolean(token) && !currentUrl.stdout.includes('@')
      if (missing || needsToken) {
        const setUrl = missing
          ? await git(path, ['remote', 'add', 'origin', authed])
          : await git(path, ['remote', 'set-url', 'origin', authed])
        steps.push({ step: missing ? 'remote-add' : 'remote-set', ...setUrl })
      }
      return { ok: true, steps, created: false }
    }
    // 3. not a repo: initialize
    const init = await git(path, ['init', '--initial-branch', cfg.branch])
    steps.push({ step: 'init', ...init })
    if (!init.ok) {
      return { ok: false, steps }
    }
    // 4. add remote
    const url = token ? authedRemote(cfg.remoteUrl, token, cfg.username) : cfg.remoteUrl
    const remoteAdd = await git(path, ['remote', 'add', 'origin', url])
    steps.push({ step: 'remote-add', ...remoteAdd })
    if (!remoteAdd.ok) {
      return { ok: false, steps }
    }
    // 5. fetch remote branch
    const fetch = await git(path, ['fetch', 'origin', '--prune'])
    steps.push({ step: 'fetch', ...fetch })
    if (!fetch.ok) {
      return { ok: false, steps }
    }
    // 6. point the local branch at the remote one when it exists. A brand-new
    // empty remote has no commit yet: keep the fresh local branch and let the
    // caller push the first commit instead of failing here.
    const remoteRef = await git(path, ['rev-parse', '--verify', '--quiet', `origin/${cfg.branch}`])
    if (!remoteRef.ok || !remoteRef.stdout) {
      steps.push({ step: 'checkout', ok: true, skipped: '远端分支尚不存在' })
      return { ok: true, steps, created: true, empty: true }
    }
    const checkout = await git(path, ['checkout', '-B', cfg.branch, `origin/${cfg.branch}`])
    steps.push({ step: 'checkout', ...checkout })
    return { ok: checkout.ok, steps, created: true }
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

      // Bootstrap the repository when it is missing or not yet a git repo.
      // A fresh machine has no ~/.agents/skills at all, so without this the
      // first pull fails with "fatal: not a git repository".
      if (cfg.remoteUrl) {
        const ensured = await ensureRepo(path, cfg, token)
        if (!ensured.ok) {
          json(res, 500, { ok: false, step: 'bootstrap', steps: ensured.steps, state: await readState(path, cfg.branch) })
          return
        }
      } else {
        try {
          await fs.mkdir(path, { recursive: true })
        } catch {
          /* ignore */
        }
        json(res, 400, { ok: false, step: 'config', reason: '尚未配置远程仓库地址', state: await readState(path, cfg.branch) })
        return
      }

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

      // `git pull` needs an upstream; a repository bootstrapped from an empty
      // remote has none yet, and a repo with local-only commits may not either.
      // Fall back to an explicit reset onto the remote branch in that case.
      const upstream = await git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      if (!upstream.ok || !upstream.stdout) {
        const remoteRef = await git(path, ['rev-parse', '--verify', '--quiet', `origin/${cfg.branch}`])
        if (!remoteRef.ok) {
          json(res, 200, {
            ok: true,
            step: 'pull',
            message: '远端仓库还没有提交，无需拉取',
            state: await readState(path, cfg.branch),
          })
          return
        }
        const set = await git(path, ['branch', '--set-upstream-to', `origin/${cfg.branch}`, cfg.branch])
        if (!set.ok) {
          json(res, 500, { ok: false, step: 'upstream', ...set, state: await readState(path, cfg.branch) })
          return
        }
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

      // Bootstrap the repository when it is missing or not yet a git repo.
      if (cfg.remoteUrl) {
        const ensured = await ensureRepo(path, cfg, token)
        if (!ensured.ok) {
          json(res, 500, { ok: false, step: 'bootstrap', steps: ensured.steps, state: await readState(path, cfg.branch) })
          return
        }
      } else {
        try {
          await fs.mkdir(path, { recursive: true })
        } catch {
          /* ignore */
        }
        json(res, 400, { ok: false, step: 'config', reason: '尚未配置远程仓库地址', state: await readState(path, cfg.branch) })
        return
      }

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
      // The target directory may not exist yet on a fresh machine.
      try {
        await fs.mkdir(path, { recursive: true })
        steps.push({ step: 'mkdir', ok: true })
      } catch (error) {
        steps.push({ step: 'mkdir', ok: false, message: error instanceof Error ? error.message : String(error) })
      }
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

  // ── self-update ──────────────────────────────────────────────────────────
  //
  // The plugin is installed either as a symlink to a development checkout or as
  // a copy produced by `plugin_manager install_bundle`. In the first case the
  // installation directory is itself a git checkout, so it can pull its own
  // updates. In the second case it is a plain directory and there is nothing to
  // pull; the UI then tells the user to reinstall instead.

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${base}/update/status`,
    async handler(req, res) {
      const result = await updateStatus()
      json(res, 200, result)
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${base}/update`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      await readBody(req)

      const status = await updateStatus()
      if (!status.git) {
        json(res, 200, {
          ok: false,
          reason: 'not-a-checkout',
          message: '当前安装目录不是 git 检出，无法自更新。请重新克隆插件目录后重装，或等待发布到插件市场。',
          ...status,
        })
        return
      }

      // Refuse to clobber local edits: the update must be a fast-forward.
      const dirty = await git(PLUGIN_DIR, ['status', '--porcelain'])
      const uncommitted = dirty.ok ? dirty.stdout.trim() : ''
      if (uncommitted.length > 0) {
        json(res, 200, {
          ok: false,
          reason: 'dirty',
          message: '插件目录存在未提交改动，已跳过更新以免覆盖本地修改。请先提交或还原后再试。',
          dirty: uncommitted.split('\n').slice(0, 20),
          ...status,
        })
        return
      }

      const fetch = await git(PLUGIN_DIR, ['fetch', '--prune'])
      if (!fetch.ok) {
        json(res, 500, { ok: false, step: 'fetch', ...fetch, ...status })
        return
      }

      const before = await git(PLUGIN_DIR, ['rev-parse', 'HEAD'])
      const pull = await git(PLUGIN_DIR, ['merge', '--ff-only', `origin/${status.branch}`])
      if (!pull.ok) {
        json(res, 500, { ok: false, step: 'merge', ...pull, ...status })
        return
      }
      const after = await git(PLUGIN_DIR, ['rev-parse', 'HEAD'])
      const changed = before.ok && after.ok ? before.stdout !== after.stdout : true

      json(res, 200, {
        ok: true,
        changed,
        branch: status.branch,
        from: before.ok ? before.stdout.slice(0, 7) : undefined,
        to: after.ok ? after.stdout.slice(0, 7) : undefined,
        message: changed
          ? '插件已更新到最新版本。请重启 DSH（或禁用再启用插件）并刷新页面使新代码生效。'
          : '已经是最新版本，无需更新。',
        ...status,
      })
    },
  }))

  /**
   * Inspect whether the installation directory is a git checkout that can be
   * updated in place, and report its version relative to the remote.
   */
  async function updateStatus() {
    const inside = await git(PLUGIN_DIR, ['rev-parse', '--git-dir'])
    if (!inside.ok) {
      return { git: false, dir: PLUGIN_DIR, version: await pluginVersion() }
    }
    const branchRef = await git(PLUGIN_DIR, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = branchRef.ok && branchRef.stdout !== 'HEAD' ? branchRef.stdout : 'main'
    const head = await git(PLUGIN_DIR, ['log', '-1', '--pretty=%h%x20%s'])
    const remote = await git(PLUGIN_DIR, ['remote', 'get-url', 'origin'])
    const behind = await git(PLUGIN_DIR, ['rev-list', '--count', `HEAD..origin/${branch}`])
    return {
      git: true,
      dir: PLUGIN_DIR,
      branch,
      remote: remote.ok ? remote.stdout : undefined,
      head: head.ok ? head.stdout : undefined,
      behind: behind.ok ? Number.parseInt(behind.stdout, 10) || 0 : null,
      version: await pluginVersion(),
    }
  }

  /** Read this plugin's own package version. */
  async function pluginVersion() {
    try {
      const raw = await fs.readFile(path.join(PLUGIN_DIR, 'package.json'), 'utf8')
      const parsed = JSON.parse(raw)
      return typeof parsed.version === 'string' ? parsed.version : undefined
    } catch {
      return undefined
    }
  }

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

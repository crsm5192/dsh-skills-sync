window.__ModuleLoader__.load({
  id: '@local/dsh-skills-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useCallback, useEffect, useRef } = React

    const BASE = '/api/skills-sync'

    // ── shared styles ──────────────────────────────────────────────────────

    const S = {
      wrap: {
        position: 'fixed',
        right: '18px',
        bottom: '96px',
        zIndex: 2147483000,
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '8px',
        fontFamily: 'inherit',
        fontSize: '12px',
      },
      pill: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 10px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-elevated, rgba(30,30,32,0.92))',
        color: 'var(--dsw-alias-text-default, inherit)',
        boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
        backdropFilter: 'blur(8px)',
        cursor: 'pointer',
        userSelect: 'none',
      },
      dot: (color) => ({
        width: '7px', height: '7px', borderRadius: '50%', background: color, flex: '0 0 auto',
      }),
      panel: {
        display: 'flex', gap: '6px', padding: '8px', borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-elevated, rgba(30,30,32,0.95))',
        color: 'var(--dsw-alias-text-default, inherit)',
        boxShadow: '0 4px 18px rgba(0,0,0,0.22)',
        backdropFilter: 'blur(8px)',
      },
      btn: (disabled, primary) => ({
        display: 'flex', alignItems: 'center', gap: '5px',
        padding: '6px 12px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.35))',
        background: primary ? 'var(--dsw-alias-accent-bg, #2f6feb)' : 'transparent',
        color: primary ? '#fff' : 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: '12px', whiteSpace: 'nowrap',
      }),
      status: {
        maxWidth: '280px', padding: '5px 9px', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-elevated, rgba(30,30,32,0.95))',
        border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.35))',
        color: 'var(--dsw-alias-text-secondary, inherit)',
        fontSize: '11px', lineHeight: '1.45', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      // settings page
      page: { padding: '20px 24px', maxWidth: '720px', color: 'var(--dsw-alias-text-default, inherit)' },
      title: { fontSize: '16px', fontWeight: 600, marginBottom: '4px' },
      desc: { fontSize: '12px', opacity: 0.65, marginBottom: '18px', lineHeight: 1.6 },
      field: { marginBottom: '14px' },
      label: { display: 'block', fontSize: '12px', marginBottom: '5px', fontWeight: 500 },
      hint: { fontSize: '11px', opacity: 0.55, marginTop: '4px', lineHeight: 1.5 },
      input: {
        width: '100%', padding: '7px 10px', borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-input, rgba(0,0,0,0.12))',
        color: 'inherit', fontSize: '12px', boxSizing: 'border-box',
      },
      row: { display: 'flex', gap: '10px', alignItems: 'center' },
      check: { display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12px', cursor: 'pointer' },
      msg: (kind) => ({
        marginTop: '12px', padding: '8px 11px', borderRadius: '7px', fontSize: '12px', lineHeight: 1.5,
        background: kind === 'error' ? 'rgba(220,60,60,0.12)' : 'rgba(60,180,90,0.12)',
        border: `1px solid ${kind === 'error' ? 'rgba(220,60,60,0.35)' : 'rgba(60,180,90,0.35)'}`,
      }),
      actions: { display: 'flex', gap: '8px', marginTop: '18px', flexWrap: 'wrap' },
    }

    async function api(path, options) {
      const response = await fetch(`${BASE}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      const data = await response.json().catch(() => ({}))
      return data
    }

    // ── floating button ────────────────────────────────────────────────────

    function SkillsSyncButton() {
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(null)
      const [message, setMessage] = useState('')
      const [state, setState] = useState(null)
      const timer = useRef(null)

      const refresh = useCallback(async () => {
        const data = await api('/state').catch(() => undefined)
        if (data?.state) setState(data.state)
      }, [])

      useEffect(() => {
        refresh()
        // Poll state every 10 seconds to update countdown
        const pollTimer = setInterval(refresh, 10000)
        return () => { 
          clearInterval(pollTimer)
          if (timer.current) clearTimeout(timer.current) 
        }
      }, [refresh])

      const run = useCallback(async (action) => {
        if (busy) return
        setBusy(action)
        setMessage(action === 'pull' ? '拉取中…' : '推送中…')
        const data = await api(`/${action}`, { method: 'POST', body: '{}' }).catch((error) => ({
          ok: false, message: error.message,
        }))
        if (data.state) setState(data.state)

        if (data.ok) {
          const parts = []
          if (action === 'push' && data.committed) parts.push('已提交本地改动')
          parts.push(action === 'pull' ? '拉取完成' : '推送完成')
          if (data.state) parts.push(`↑${data.state.ahead ?? 0} ↓${data.state.behind ?? 0}`)
          setMessage(parts.join(' · '))
        } else {
          const detail = (data.stderr || data.message || data.reason || '').split('\n')[0] || '未知错误'
          setMessage(`${action === 'pull' ? '拉取' : '推送'}失败（${data.step || 'git'}）：${detail}`)
        }

        setBusy(null)
        refresh()
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setMessage(''), 8000)
      }, [busy, refresh])

      let dotColor = '#3fb950'
      if (state) {
        if (state.dirtyCount > 0) dotColor = '#d29922'
        else if (state.ahead > 0) dotColor = '#58a6ff'
        else if (state.behind > 0) dotColor = '#a371f7'
      }

      // Build title with sync status
      const syncStatus = state ? [
        `分支：${state.branch}`,
        `未提交：${state.dirtyCount}`,
        `↑${state.ahead} ↓${state.behind}`,
      ] : ['技能同步']
      
      if (state?.autoSyncEnabled) {
        const nextIn = state.nextSyncIn !== null ? `${state.nextSyncIn}s` : '-'
        syncStatus.push(`自动：下次 ${nextIn}`)
      }

      return h('div', { style: S.wrap },
        message ? h('div', { style: S.status }, message) : null,
        open ? h('div', { style: S.panel },
          h('button', {
            type: 'button', style: S.btn(busy !== null, false), disabled: busy !== null,
            onClick: () => run('pull'), title: '从远程仓库拉取最新技能',
          }, busy === 'pull' ? '拉取中…' : '拉取'),
          h('button', {
            type: 'button', style: S.btn(busy !== null, true), disabled: busy !== null,
            onClick: () => run('push'), title: '提交并推送本地改动',
          }, busy === 'push' ? '推送中…' : '推送'),
        ) : null,
        h('div', {
          style: S.pill, role: 'button', tabIndex: 0,
          title: syncStatus.join(' | '),
          onClick: () => setOpen((v) => !v),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((v) => !v) }
          },
        },
          h('span', { style: S.dot(dotColor) }),
          h('span', null, '技能同步'),
          h('span', { style: { opacity: 0.6, fontSize: '10px' } }, open ? '▾' : '▴'),
        ),
      )
    }

    // ── settings page ──────────────────────────────────────────────────────

    function SkillsSyncSettings() {
      const [config, setConfig] = useState(null)
      const [defaults, setDefaults] = useState({})
      const [form, setForm] = useState(null)
      const [token, setToken] = useState('')
      const [busy, setBusy] = useState(null)
      const [message, setMessage] = useState(null)
      const [update, setUpdate] = useState(null)

      const load = useCallback(async () => {
        const data = await api('/config').catch(() => undefined)
        if (data?.ok) {
          setConfig(data.config)
          setDefaults(data.defaults ?? {})
          setForm({
            repoPath: data.config.repoPath || data.defaults?.repoPath || '',
            remoteUrl: data.config.remoteUrl || '',
            branch: data.config.branch || 'main',
            provider: data.config.provider || 'github',
            username: data.config.username || '',
            private: data.config.private !== false,
            autoCreateRepo: data.config.autoCreateRepo !== false,
            discipline: data.config.discipline !== false,
            autoSync: data.config.autoSync !== false,
            syncInterval: data.config.syncInterval || 300,
          })
        } else {
          setMessage({ kind: 'error', text: '无法读取当前配置' })
        }
      }, [])

      const checkUpdateStatus = useCallback(async () => {
        try {
          const data = await api('/update/status')
          if (data.ok && data.git) {
            setUpdate({
              installed: data.version,
              branch: data.branch,
              behind: data.behind || 0,
              head: data.head,
            })
          } else {
            setUpdate({ git: false, installed: data?.version || 'unknown' })
          }
        } catch {
          setUpdate(null)
        }
      }, [])

      useEffect(() => { load() }, [load])
      useEffect(() => { checkUpdateStatus() }, [checkUpdateStatus])

      const set = (key) => (event) => {
        const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value
        setForm((prev) => ({ ...prev, [key]: value }))
      }

      const save = async () => {
        setBusy('save')
        setMessage(null)
        const payload = { ...form }
        if (token) payload.token = token
        const data = await api('/config', { method: 'POST', body: JSON.stringify(payload) })
          .catch((error) => ({ ok: false, reason: error.message }))
        if (data.ok) {
          setMessage({ kind: 'ok', text: '配置已保存。若插件重启后仍显示旧值，请刷新页面。' })
          setToken('')
          await load()
        } else {
          setMessage({ kind: 'error', text: `保存失败：${data.reason || '未知原因'}` })
        }
        setBusy(null)
      }

      const test = async () => {
        setBusy('test')
        setMessage(null)
        const payload = { remoteUrl: form.remoteUrl, username: form.username }
        if (token) payload.token = token
        const data = await api('/test', { method: 'POST', body: JSON.stringify(payload) })
          .catch((error) => ({ ok: false, reason: error.message }))
        if (data.ok) {
          setMessage({
            kind: 'ok',
            text: data.exists
              ? `仓库可访问${data.private ? '（私有）' : '（公开）'}`
              : '连接正常，但仓库尚不存在。可点击「创建仓库」。',
          })
        } else {
          setMessage({ kind: 'error', text: `连接失败：${data.reason || '未知原因'}` })
        }
        setBusy(null)
      }

      const createRepo = async () => {
        setBusy('create')
        setMessage(null)
        const payload = { remoteUrl: form.remoteUrl, private: form.private }
        if (token) payload.token = token
        const data = await api('/create-repo', { method: 'POST', body: JSON.stringify(payload) })
          .catch((error) => ({ ok: false, reason: error.message }))
        if (data.ok) setMessage({ kind: 'ok', text: `仓库已创建：${data.url}` })
        else setMessage({ kind: 'error', text: `创建失败：${data.reason || '未知原因'}` })
        setBusy(null)
      }

      const initRepo = async () => {
        setBusy('init')
        setMessage(null)
        const payload = { repoPath: form.repoPath, remoteUrl: form.remoteUrl, branch: form.branch }
        if (token) payload.token = token
        const data = await api('/init', { method: 'POST', body: JSON.stringify(payload) })
          .catch((error) => ({ ok: false, reason: error.message }))
        if (data.ok) setMessage({ kind: 'ok', text: '本地仓库已初始化并推送。' })
        else {
          const failed = (data.steps || []).filter((s) => s.ok === false)
          const detail = failed.length > 0
            ? `${failed[0].step}: ${(failed[0].stderr || failed[0].message || '').split('\n')[0]}`
            : (data.reason || '未知原因')
          setMessage({ kind: 'error', text: `初始化失败：${detail}` })
        }
        setBusy(null)
      }

      const doUpdate = async () => {
        setBusy('update')
        setMessage(null)
        const data = await api('/update', { method: 'POST' })
          .catch((error) => ({ ok: false, reason: error.message }))
        if (data.ok) {
          setMessage({ kind: 'ok', text: data.message || '更新完成，请重启 DSH 并刷新页面。' })
          await checkUpdateStatus()
        } else {
          setMessage({ kind: 'error', text: data.message || data.reason || '更新失败' })
        }
        setBusy(null)
      }

      if (form === null) {
        return h('div', { style: S.page }, h('div', { style: S.desc }, '加载中…'))
      }

      return h('div', { style: S.page },
        h('div', { style: S.title }, '技能同步'),
        h('div', { style: S.desc },
          '把自建技能统一归档到一个 git 仓库，并在多台电脑之间同步。' +
          'token 保存在 DSH 凭据库，不会写入配置文件。'),

        h('div', { style: S.field },
          h('label', { style: S.label }, '技能存档目录'),
          h('input', { style: S.input, value: form.repoPath, onChange: set('repoPath'),
            placeholder: defaults.repoPath || 'C:\\Users\\<you>\\.agents\\skills' }),
          h('div', { style: S.hint }, '自建技能一律保存到这里。留空则使用 DSH 用户级技能目录。'),
        ),

        h('div', { style: S.field },
          h('label', { style: S.label }, '仓库地址'),
          h('input', { style: S.input, value: form.remoteUrl, onChange: set('remoteUrl'),
            placeholder: 'https://github.com/<owner>/<repo>.git' }),
          h('div', { style: S.hint }, '仓库不存在时可点击下方「创建仓库」自动创建。'),
        ),

        h('div', { style: S.row },
          h('div', { style: { ...S.field, flex: 1 } },
            h('label', { style: S.label }, '分支'),
            h('input', { style: S.input, value: form.branch, onChange: set('branch') }),
          ),
          h('div', { style: { ...S.field, flex: 1 } },
            h('label', { style: S.label }, '用户名'),
            h('input', { style: S.input, value: form.username, onChange: set('username'),
              placeholder: 'GitHub 用户名' }),
          ),
        ),

        h('div', { style: S.field },
          h('label', { style: S.label }, '访问令牌（token）'),
          h('input', {
            style: S.input, type: 'password', value: token,
            onChange: (event) => setToken(event.target.value),
            placeholder: config?.tokenConfigured ? '已配置，留空则不修改' : 'ghp_... 或 gitee 私人令牌',
          }),
          h('div', { style: S.hint }, '保存在 DSH 凭据库，仅用于 git 推送与仓库 API 调用。'),
        ),

        h('div', { style: { ...S.field, display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('label', { style: S.check },
            h('input', { type: 'checkbox', checked: form.private, onChange: set('private') }),
            '仓库设为私有（推荐）',
          ),
          h('label', { style: S.check },
            h('input', { type: 'checkbox', checked: form.autoCreateRepo, onChange: set('autoCreateRepo') }),
            '仓库不存在时允许自动创建',
          ),
          h('label', { style: S.check },
            h('input', { type: 'checkbox', checked: form.discipline, onChange: set('discipline') }),
            '向 Agent 注入技能存档纪律（要求自建技能写入上述目录）',
          ),
        ),

        // ── auto-sync section ──────────────────────────────────────────
        h('div', { style: { marginTop: '24px', borderTop: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.2))', paddingTop: '18px' } },
          h('div', { style: { ...S.title, fontSize: '14px', marginBottom: '8px' } }, '定时自动同步'),
          h('div', { style: S.desc }, 
            '后台定时检查本地与远端仓库的差异，发现远端有新提交时自动拉取。'),
          
          h('div', { style: { ...S.field, marginTop: '14px' } },
            h('label', { style: S.check },
              h('input', { type: 'checkbox', checked: form.autoSync, onChange: set('autoSync') }),
              '启用定时自动同步',
            ),
          ),

          form.autoSync ? h('div', { style: S.field },
            h('label', { style: S.label }, '同步频率'),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h('select', {
                style: { ...S.input, flex: 1 },
                value: String(form.syncInterval),
                onChange: (e) => setForm({ ...form, syncInterval: Number.parseInt(e.target.value, 10) }),
              },
                h('option', { value: '60' }, '每 1 分钟'),
                h('option', { value: '120' }, '每 2 分钟'),
                h('option', { value: '300' }, '每 5 分钟（推荐）'),
                h('option', { value: '600' }, '每 10 分钟'),
                h('option', { value: '1800' }, '每 30 分钟'),
                h('option', { value: '3600' }, '每 1 小时'),
              ),
            ),
            h('div', { style: S.hint }, 
              '自动同步仅拉取远端更新，不会自动推送本地改动。' +
              '如需推送请使用悬浮按钮或手动点击推送。'),
          ) : null,

          config?.tokenConfigured === false && form.autoSync ? h('div', { 
            style: { ...S.msg('error'), marginTop: '12px' } 
          }, '⚠️ 尚未配置访问令牌，自动同步可能无法拉取私有仓库。请先在上方配置 token。') : null,
        ),

        // ── plugin self-update section ─────────────────────────────────
        h('div', { style: { marginTop: '24px', borderTop: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.2))', paddingTop: '18px' } },
          h('div', { style: { ...S.title, fontSize: '14px', marginBottom: '8px' } }, '插件更新'),
          h('div', { style: S.desc },
            '本插件自身也从 git 更新。更新后需要重启 DSH（或禁用再启用插件）并刷新页面，新代码才会生效。'),

          update === null
            ? h('div', { style: S.hint }, '正在检查版本…')
            : update.git === false
              ? h('div', { style: S.hint },
                  `当前安装目录不是 git 检出，无法自更新。已安装版本：${update.installed || '未知'}。` +
                  '请重新克隆插件目录后重装，或使用插件市场升级。')
              : h('div', { style: S.hint },
                  `已安装版本：${update.installed || '未知'}` +
                  (update.branch ? `　分支：${update.branch}` : '') +
                  (update.behind > 0 ? `　可更新：${update.behind} 个提交` : '　已是最新')),

          update && update.git !== false
            ? h('div', { style: { ...S.actions, marginTop: '12px' } },
                h('button', {
                  type: 'button',
                  style: S.btn(busy !== null, false),
                  disabled: busy !== null,
                  onClick: doUpdate,
                }, busy === 'update' ? '更新中…' : '检查并更新插件'),
              )
            : null,
        ),

        message ? h('div', { style: S.msg(message.kind) }, message.text) : null,

        h('div', { style: S.actions },
          h('button', { type: 'button', style: S.btn(busy !== null, true), disabled: busy !== null, onClick: save },
            busy === 'save' ? '保存中…' : '保存'),
          h('button', { type: 'button', style: S.btn(busy !== null, false), disabled: busy !== null, onClick: test },
            busy === 'test' ? '测试中…' : '测试连接'),
          h('button', { type: 'button', style: S.btn(busy !== null, false), disabled: busy !== null, onClick: createRepo },
            busy === 'create' ? '创建中…' : '创建仓库'),
          h('button', { type: 'button', style: S.btn(busy !== null, false), disabled: busy !== null, onClick: initRepo },
            busy === 'init' ? '初始化中…' : '初始化本地仓库'),
        ),
      )
    }

    // ── registration ───────────────────────────────────────────────────────

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'skills-sync-button', order: 20,
        }, SkillsSyncButton))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'skills-sync',
          order: 60,
          label: '技能同步',
        }, SkillsSyncSettings))
      },
    }
  },
})

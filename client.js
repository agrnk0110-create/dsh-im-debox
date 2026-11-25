/*
 * DeBox bot settings panel.
 *
 * The Host half (index.js) owns the long poll, the credential store and the
 * profile configuration; this file renders the Settings section and talks to it
 * over the Connection RPC envelope:
 *   rpc.call('/api', 'dsh-im-debox', { method, payload })
 *
 * Visual intent: airy, editorial spacing; one quiet surface per group; ink
 * primary action with the DeBox green kept for status and focus; a single brass
 * hairline as the only ornament.
 */
window.__ModuleLoader__.load({
  id: 'dsh-im-debox',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const RPC_ENDPOINT = 'dsh-im-debox'
    const STYLE_ID = 'dsh-im-debox-panel-style'

    /** The DeBox app icon, redrawn as inline SVG so the panel needs no asset. */
    function DeBoxLogo({ size = 16 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 64 64',
          width: size,
          height: size,
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        h('rect', { key: 'bg', width: 64, height: 64, rx: 14, fill: '#21C161' }),
        h('path', {
          key: 'bubble',
          fill: '#fff',
          d: 'M18.67 18.67h26.22a4.44 4.44 0 0 1 4.44 4.44v16.44a4.44 4.44 0 0 1-4.44 4.44H23.56l-3.99 4.45v-4.45a4.44 4.44 0 0 1-5.34-4.34V23.11a4.44 4.44 0 0 1 4.44-4.44z',
        }),
        h('circle', { key: 'notch', cx: 46.2, cy: 32, r: 5.8, fill: '#21C161' }),
        h('circle', { key: 'notch-inner', cx: 46.2, cy: 32, r: 2.2, fill: '#fff' }),
      )
    }

    /*
     * Inline styles cannot express :focus or :hover, and both carry most of the
     * perceived polish. One scoped sheet, injected once per document.
     */
    function installStyles() {
      const document = globalThis.document
      if (!document || document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = [
        '.dp-field{transition:border-color 140ms ease,box-shadow 140ms ease,background-color 140ms ease}',
        '.dp-field:hover:not(:disabled){border-color:rgba(120,120,128,.34)}',
        '.dp-field:focus{outline:none;border-color:rgba(33,193,97,.75)!important;box-shadow:0 0 0 4px rgba(33,193,97,.13)}',
        '.dp-primary{transition:background-color 140ms ease,transform 140ms ease,box-shadow 140ms ease}',
        '.dp-primary:hover:not(:disabled){background:#20242b!important;box-shadow:0 6px 18px -6px rgba(16,24,40,.4)}',
        '.dp-primary:active:not(:disabled){transform:translateY(1px)}',
        '.dp-ghost{transition:border-color 140ms ease,color 140ms ease}',
        '.dp-ghost:hover:not(:disabled){border-color:rgba(120,120,128,.4)}',
        '.dp-link{transition:color 140ms ease}',
        '.dp-link:hover:not(:disabled){color:#21C161}',
        '.dp-toggle{transition:background-color 160ms ease}',
        '.dp-toggle:hover:not(:disabled){filter:brightness(1.04)}',
        '.dp-row:hover{background:rgba(120,120,128,.035)}',
      ].join('')
      document.head.appendChild(el)
    }

    const MUTED = 'var(--dsw-alias-label-secondary, #6b7280)'
    const HAIRLINE = 'var(--dsw-alias-border-primary, rgba(0,0,0,0.08))'
    const SURFACE = 'var(--dsw-alias-bg-primary, #fff)'
    const INK = '#14171c'
    const GREEN = '#21C161'
    const BRASS = '#C9A96B'

    const shadow = '0 1px 2px rgba(16,24,40,0.04), 0 16px 40px -20px rgba(16,24,40,0.18)'

    const style = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
        maxWidth: 780,
        padding: '6px 0 40px',
        color: 'var(--dsw-alias-label-primary, #111)',
        fontSize: 14,
        lineHeight: '22px',
      },
      hero: { display: 'flex', alignItems: 'flex-start', gap: 16 },
      mark: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 52,
        height: 52,
        borderRadius: 16,
        background: SURFACE,
        border: '1px solid ' + HAIRLINE,
        boxShadow: shadow,
        flex: 'none',
      },
      heroText: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, paddingTop: 2 },
      heroTitle: {
        margin: 0,
        fontSize: 22,
        fontWeight: 600,
        lineHeight: '30px',
        letterSpacing: '0.01em',
      },
      heroSub: { fontSize: 13, lineHeight: '21px', color: MUTED, maxWidth: 540 },
      rule: {
        height: 1,
        border: 0,
        margin: '-10px 0 0',
        background: 'linear-gradient(90deg, ' + BRASS + ', rgba(201,169,107,0.28) 28%, transparent 70%)',
        opacity: 0.55,
      },
      pill: (tone) => {
        const map = {
          ok: { fg: '#12734a', bg: 'rgba(33,193,97,0.09)', bd: 'rgba(33,193,97,0.26)' },
          warn: { fg: '#8a5a00', bg: 'rgba(217,138,0,0.10)', bd: 'rgba(217,138,0,0.26)' },
          bad: { fg: '#93311f', bg: 'rgba(180,35,24,0.07)', bd: 'rgba(180,35,24,0.22)' },
        }
        const tone_ = map[tone] ?? map.bad
        return {
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 18px',
          borderRadius: 999,
          background: tone_.bg,
          border: '1px solid ' + tone_.bd,
          color: tone_.fg,
        }
      },
      statusText: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 },
      statusMain: { fontSize: 13.5, fontWeight: 600, letterSpacing: '0.01em' },
      statusSub: { fontSize: 12, opacity: 0.75 },
      dot: (tone) => ({
        width: 7,
        height: 7,
        borderRadius: 999,
        flex: 'none',
        background: tone === 'ok' ? GREEN : tone === 'warn' ? '#d98a00' : '#b42318',
        boxShadow: tone === 'ok' ? '0 0 0 4px rgba(33,193,97,0.16)' : 'none',
      }),
      group: { display: 'flex', flexDirection: 'column', gap: 10 },
      groupTitle: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px' },
      brassMark: { width: 2, height: 11, borderRadius: 2, background: BRASS, opacity: 0.85, flex: 'none' },
      groupLabel: {
        fontSize: 11.5,
        fontWeight: 600,
        letterSpacing: '0.12em',
        color: MUTED,
        textTransform: 'uppercase',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        background: SURFACE,
        border: '1px solid ' + HAIRLINE,
        borderRadius: 18,
        boxShadow: shadow,
        overflow: 'hidden',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 24,
        padding: '16px 22px',
        borderTop: '1px solid ' + HAIRLINE,
        transition: 'background-color 140ms ease',
      },
      rowStack: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '16px 22px',
        borderTop: '1px solid ' + HAIRLINE,
      },
      first: { borderTop: 'none' },
      label: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
      labelText: { fontSize: 13.5, fontWeight: 500, letterSpacing: '0.005em' },
      hint: { fontSize: 12, lineHeight: '18px', color: MUTED },
      control: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 1 auto', minWidth: 0 },
      input: {
        height: 38,
        padding: '0 12px',
        boxSizing: 'border-box',
        borderRadius: 10,
        border: '1px solid ' + HAIRLINE,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        letterSpacing: '0.01em',
      },
      area: {
        width: '100%',
        minHeight: 84,
        padding: '10px 12px',
        boxSizing: 'border-box',
        borderRadius: 10,
        border: '1px solid ' + HAIRLINE,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        lineHeight: '21px',
        resize: 'vertical',
      },
      ghost: {
        height: 38,
        padding: '0 16px',
        borderRadius: 10,
        border: '1px solid ' + HAIRLINE,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      link: {
        height: 38,
        padding: '0 2px',
        border: 'none',
        background: 'transparent',
        color: MUTED,
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        letterSpacing: '0.01em',
      },
      primary: {
        height: 40,
        padding: '0 26px',
        borderRadius: 12,
        border: 'none',
        background: INK,
        color: '#fff',
        font: 'inherit',
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: '0.02em',
        cursor: 'pointer',
        boxShadow: '0 1px 2px rgba(16,24,40,0.2), 0 10px 24px -12px rgba(16,24,40,0.45)',
      },
      disabled: { opacity: 0.42, cursor: 'default', boxShadow: 'none' },
      toggle: {
        position: 'relative',
        width: 38,
        height: 22,
        borderRadius: 999,
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        flex: 'none',
        background: 'rgba(120,120,128,0.26)',
      },
      knob: (on) => ({
        position: 'absolute',
        top: 3,
        left: on ? 19 : 3,
        width: 16,
        height: 16,
        borderRadius: 999,
        background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.28)',
        transition: 'left 160ms cubic-bezier(.4,0,.2,1)',
      }),
      footer: { display: 'flex', alignItems: 'center', gap: 16, padding: '2px 2px 0' },
      notice: { fontSize: 12.5, color: MUTED, letterSpacing: '0.01em' },
      errorBox: {
        fontSize: 12.5,
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-error, #b42318)',
        padding: '10px 14px',
        border: '1px solid rgba(180,35,24,0.22)',
        borderRadius: 12,
        background: 'rgba(180,35,24,0.05)',
        wordBreak: 'break-all',
      },
    }

    /**
     * Session ids the Host reported as DeBox-owned. The value lives at module
     * scope because the sidebar row is rendered outside the settings panel.
     */
    const deboxSessions = { ids: new Set(), listeners: new Set() }
    function publishSessionIds(list) {
      deboxSessions.ids = new Set(Array.isArray(list) ? list : [])
      for (const notify of deboxSessions.listeners) notify()
    }
    function useDeboxSession(sessionId) {
      const [owned, setOwned] = useState(() => deboxSessions.ids.has(sessionId))
      useEffect(() => {
        const sync = () => setOwned(deboxSessions.ids.has(sessionId))
        deboxSessions.listeners.add(sync)
        sync()
        return () => deboxSessions.listeners.delete(sync)
      }, [sessionId])
      return owned
    }

    /** The row mark: DeBox's own app icon, drawn inline so no asset is needed. */
    function DeBoxRowMark({ sessionId }) {
      const owned = useDeboxSession(sessionId)
      if (!owned) return null
      return h(DeBoxLogo, { size: 14 })
    }

    /** One unary call to the Host half; throws the Host's message on refusal. */
    function call(ctx, method, payload) {
      return ctx.connection.rpc
        .call('/api', RPC_ENDPOINT, { method, payload }, undefined)
        .then((result) => {
          if (result === null || typeof result !== 'object') throw new Error('空响应')
          if (result.ok !== true) {
            const message = result.error && result.error.message ? result.error.message : '请求失败'
            throw new Error(String(message))
          }
          return result.value
        })
    }

    /**
     * Ask the host for a directory: the desktop shell exposes a native AppKit
     * panel, and the workspace remote offers the same pick behind its own
     * capability gate. Cancelling leaves the current path untouched.
     */
    async function pickDirectory(ctx) {
      const bridge = globalThis.__DSH_DIRECTORY_PICKER__
      if (bridge !== undefined && bridge !== null && typeof bridge.pick === 'function') {
        return await bridge.pick()
      }
      let workspace
      try {
        workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
      } catch {
        workspace = undefined
      }
      if (workspace !== undefined && workspace !== null && typeof workspace.pickDirectory === 'function') {
        return await workspace.pickDirectory()
      }
      throw new Error('当前宿主没有目录选择器，请手动输入路径')
    }

    function Row({ first, label, hint, children }) {
      return h(
        'div',
        { className: 'dp-row', style: first ? Object.assign({}, style.row, style.first) : style.row },
        h(
          'div',
          { style: style.label },
          h('span', { style: style.labelText }, label),
          hint ? h('span', { style: style.hint }, hint) : null,
        ),
        h('div', { style: style.control }, children),
      )
    }

    function StackRow({ first, label, hint, children }) {
      return h(
        'div',
        { style: first ? Object.assign({}, style.rowStack, style.first) : style.rowStack },
        h(
          'div',
          { style: style.label },
          h('span', { style: style.labelText }, label),
          hint ? h('span', { style: style.hint }, hint) : null,
        ),
        children,
      )
    }

    function Group(props) {
      const items = React.Children.toArray(props.children)
      return h(
        'div',
        { style: style.group },
        h(
          'div',
          { style: style.groupTitle },
          h('span', { style: style.brassMark }),
          h('span', { style: style.groupLabel }, props.title),
        ),
        h('div', { style: style.card }, items),
      )
    }

    function Toggle({ on, onClick, label, disabled }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          'aria-label': label,
          disabled,
          className: 'dp-toggle',
          style: Object.assign(
            {},
            style.toggle,
            { background: on ? GREEN : 'rgba(120,120,128,0.26)' },
            disabled ? style.disabled : null,
          ),
          onClick,
        },
        h('span', { style: style.knob(on) }),
      )
    }

    function StatusBar({ status, embedded }) {
      const tone = status && status.connected ? 'ok' : status && status.keyConfigured ? 'warn' : 'bad'
      const main = !status
        ? '正在读取状态…'
        : status.connected
          ? '已连接 · ' + (status.botName || 'DeBox 机器人')
          : status.keyConfigured
            ? '未连接（密钥已保存，正在重连）'
            : '未连接（还没有 App Key）'
      const bits = []
      if (status && status.botUserId) bits.push(status.botUserId)
      if (status && status.lastUpdateAt) bits.push('最近消息 ' + new Date(status.lastUpdateAt).toLocaleTimeString())
      if (status && status.allowAll) bits.push('允许任意用户')
      // Embedded: the status line is the first block of the connection card, so
      // it drops the pill outline and spans the card instead of floating above it.
      const box = embedded
        ? Object.assign({}, style.pill(tone), {
            borderRadius: 0,
            border: 'none',
            borderBottom: '1px solid ' + HAIRLINE,
            padding: '15px 22px',
          })
        : style.pill(tone)
      return h(
        'div',
        { style: box },
        h('span', { style: style.dot(tone) }),
        h(
          'div',
          { style: style.statusText },
          h('span', { style: style.statusMain }, main),
          bits.length ? h('span', { style: style.statusSub }, bits.join('  ·  ')) : null,
        ),
        status && status.lastError
          ? h(
              'span',
              {
                style: Object.assign({}, style.hint, {
                  color: 'inherit',
                  maxWidth: 250,
                  textAlign: 'right',
                  opacity: 0.85,
                }),
                title: status.lastError,
              },
              status.lastError,
            )
          : null,
      )
    }

    function DeBoxSection(props) {
      const ctx = props.ctx
      const [status, setStatus] = useState(null)
      const [apiKey, setApiKey] = useState('')
      const [workdir, setWorkdir] = useState('')
      const [allowAll, setAllowAll] = useState(false)
      const [users, setUsers] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const baseline = useRef(null)

      const formOf = (value) => ({
        workdir: typeof value.workdir === 'string' ? value.workdir : '',
        allowAll: value.allowAll === true,
        users: Array.isArray(value.allowedUsers) ? value.allowedUsers.join('\n') : '',
      })
      const adopt = useCallback((value, reset) => {
        setStatus(value)
        const form = formOf(value)
        setWorkdir(form.workdir)
        setAllowAll(form.allowAll)
        setUsers(form.users)
        if (reset || baseline.current === null) baseline.current = form
      }, [])

      const refresh = useCallback(() => {
        return call(ctx, 'status', {})
          .then((value) => adopt(value, false))
          .catch((err) => setError(err.message))
      }, [ctx, adopt])

      useEffect(() => {
        let live = true
        void refresh()
        const timer = setInterval(() => {
          if (live) void call(ctx, 'status', {}).then((value) => live && adopt(value, false)).catch(() => {})
        }, 15000)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [ctx, adopt, refresh])

      const dirty = useMemo(() => {
        const base = baseline.current
        if (base === null) return apiKey.trim() !== ''
        return (
          apiKey.trim() !== '' ||
          workdir !== base.workdir ||
          allowAll !== base.allowAll ||
          users !== base.users
        )
      }, [apiKey, workdir, allowAll, users])

      const run = useCallback((name, task) => {
        setBusy(name)
        setError('')
        setNotice('')
        return task()
          .catch((err) => setError(err.message))
          .finally(() => setBusy(''))
      }, [])

      const onSave = () => {
        void run('save', async () => {
          const payload = {
            workdir: workdir.trim(),
            allowAll,
            allowedUsers: users.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean),
          }
          const key = apiKey.trim()
          if (key !== '') payload.apiKey = key
          const result = await call(ctx, 'save', payload)
          setApiKey('')
          baseline.current = formOf({ workdir: payload.workdir, allowAll, allowedUsers: payload.allowedUsers })
          const rebooting = Boolean(result && (result.restarting || result.reloaded))
          setNotice(rebooting ? '已保存，正在重新连接 DeBox…' : '已保存')
          if (rebooting) {
            // The channel reboots a tick after the reply; poll twice so the
            // status pill flips from 未连接 to 已连接 without a manual refresh.
            for (const delay of [1200, 3000, 6000]) {
              setTimeout(() => void call(ctx, 'status', {}).then((value) => adopt(value, true)).catch(() => {}), delay)
            }
          } else {
            setTimeout(() => void refresh(), 400)
          }
        })
      }

      const onReset = () => {
        const base = baseline.current
        setApiKey('')
        setError('')
        setNotice('')
        if (base === null) return
        setWorkdir(base.workdir)
        setAllowAll(base.allowAll)
        setUsers(base.users)
      }

      const onTest = () => {
        void run('test', async () => {
          const me = await call(ctx, 'test', {})
          setNotice('连接正常：' + (me.name || '?') + '（' + (me.userId || '?') + '）')
        })
      }

      const onPickDirectory = () => {
        setError('')
        setNotice('')
        void pickDirectory(ctx)
          .then((dir) => {
            if (typeof dir === 'string' && dir !== '') {
              setWorkdir(dir)
              setNotice('已选择：' + dir)
            }
          })
          .catch((err) => setError(err.message))
      }

      const onClear = () => {
        void run('clear', async () => {
          await call(ctx, 'clearKey', {})
          setApiKey('')
          setNotice('密钥已清除')
          await refresh()
        })
      }

      const keyConfigured = status !== null && status.keyConfigured === true
      const disabled = busy !== ''

      return h(
        'div',
        { style: style.page },
        h(
          'div',
          { style: style.hero },
          h('div', { style: style.mark }, h(DeBoxLogo, { size: 30 })),
          h(
            'div',
            { style: style.heroText },
            h('h1', { style: style.heroTitle }, 'DeBox 机器人'),
            h('span', { style: style.heroSub }, '在 DeBox 里直接发消息，交给 DeepSeek Harness 执行，结果回到同一个聊天。'),
          ),
        ),
        h('hr', { style: style.rule }),

        h(
          Group,
          { title: '连接' },
          h(StatusBar, { status, embedded: true }),
          h(
            Row,
            {
              label: 'Bot App Key',
              hint: keyConfigured ? '已保存在凭证库；留空表示不修改' : '在 DeBox 的 BotMother 里创建机器人后获取',
            },
            h('input', {
              className: 'dp-field',
              type: 'password',
              style: Object.assign({}, style.input, { width: 260 }),
              value: apiKey,
              placeholder: keyConfigured ? '••••••••••••••••' : 'AK 开头的 App Key',
              onChange: (event) => setApiKey(event.target.value),
              autoComplete: 'off',
              spellCheck: false,
              disabled,
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dp-link',
                style: Object.assign({}, style.link, disabled || !keyConfigured ? style.disabled : null),
                disabled: disabled || !keyConfigured,
                onClick: onTest,
              },
              busy === 'test' ? '测试中…' : '测试连接',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dp-link',
                style: Object.assign({}, style.link, disabled || !keyConfigured ? style.disabled : null),
                disabled: disabled || !keyConfigured,
                onClick: onClear,
              },
              '清除',
            ),
          ),
        ),

        h(
          Group,
          { title: '任务执行' },
          h(
            Row,
            { first: true, label: '工作区目录', hint: 'DeBox 消息触发的会话都在这里创建和读写' },
            h('input', {
              className: 'dp-field',
              style: Object.assign({}, style.input, { width: 280 }),
              value: workdir,
              placeholder: '选择或输入目录',
              onChange: (event) => setWorkdir(event.target.value),
              spellCheck: false,
              disabled,
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dp-ghost',
                style: Object.assign({}, style.ghost, disabled ? style.disabled : null),
                disabled,
                onClick: onPickDirectory,
              },
              '选择目录…',
            ),
          ),
          h(
            StackRow,
            { label: '允许的 DeBox 用户', hint: '每行一个 user_id，也可用逗号分隔；在 DeBox 里给机器人发 /id 可以查到' },
            h('textarea', {
              className: 'dp-field',
              style: style.area,
              value: users,
              placeholder: 'u1abcxyz',
              onChange: (event) => setUsers(event.target.value),
              spellCheck: false,
              disabled,
            }),
          ),
          h(
            Row,
            { label: '允许任意用户', hint: '任何人都能触发任务（不推荐）' },
            h(Toggle, {
              on: allowAll,
              label: '允许任意用户',
              disabled,
              onClick: () => !disabled && setAllowAll(!allowAll),
            }),
          ),
        ),

        h(
          'div',
          { style: style.footer },
          h(
            'button',
            {
              type: 'button',
              className: 'dp-primary',
              style: Object.assign({}, style.primary, disabled || !dirty ? style.disabled : null),
              disabled: disabled || !dirty,
              onClick: onSave,
            },
            busy === 'save' ? '保存中…' : '保存',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dp-link',
              style: Object.assign({}, style.link, !dirty || disabled ? style.disabled : null),
              disabled: !dirty || disabled,
              onClick: onReset,
            },
            '还原',
          ),
          h('span', { style: style.notice }, notice || (dirty ? '有未保存的更改' : '保存后插件会重启一次，面板自动刷新')),
        ),
        error ? h('div', { style: style.errorBox }, error) : null,
      )
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        installStyles()
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'debox',
              order: 22,
              label: () => 'DeBox 机器人',
            },
            (props) => h(DeBoxSection, Object.assign({}, props, { ctx })),
          ),
        )
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register(
            { name: 'settings.section.icon', id: 'debox' },
            (owner = {}) => h(DeBoxLogo, { size: owner.size ?? 16 }),
          ),
        )
        ctx.slots.inject('sidebar.session.row.leading', () =>
          ctx.slots.register(
            { name: 'sidebar.session.row.leading', id: 'debox' },
            (owner = {}) => h(DeBoxRowMark, { sessionId: owner.sessionId }),
          ),
        )
        ctx.effect(() => {
          let live = true
          const refresh = () => {
            call(ctx, 'status', {})
              .then((value) => live && publishSessionIds(value && value.sessionIds))
              .catch(() => {})
          }
          const wake = () => {
            if (globalThis.document?.hidden !== true) refresh()
          }
          refresh()
          const timer = setInterval(refresh, 10000)
          globalThis.window?.addEventListener('focus', wake)
          return () => {
            live = false
            clearInterval(timer)
            globalThis.window?.removeEventListener('focus', wake)
          }
        }, 'dsh-im-debox: session marks')
      },
    }
  },
})

/**
 * Web half of the DSH screenshot bundle.
 *
 * Registers one compact control at the left of the composer tool row. Clicking it
 * offers region capture (drag a rectangle over the frozen screen) and full-screen
 * capture, each with or without the Harness window. The Host writes the PNG into
 * the session workspace and this module drops it into the composer through the
 * composer's own paste intake, so it lands as an ordinary draft attachment.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-screenshot',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'screenshot'
    /** Workspace-relative path the Host command leaves the capture at. */
    const DRAFT_PATH = '.dsh-screenshots/latest.png'
    /** How long the floating notice stays after a failure. */
    const NOTICE_MS = 6000
    /** The Host's machine-readable "the user pressed Esc" result. */
    const CANCELLED = 'cancelled'

    /** Simplified Chinese copy (the key-set source of truth). */
    const zh = {
      'button.label': '截图',
      'button.busy': '正在截图…',
      'group.region': '区域截图',
      'group.full': '整屏截图',
      'action.hide': '隐藏本窗口',
      'action.plain': '原样',
      'action.regionHideHint': '拖框选择范围，本窗口先收起',
      'action.regionPlainHint': '拖框选择范围，保留本窗口',
      'action.fullHideHint': '抓取整块桌面，本窗口先收起',
      'action.fullPlainHint': '抓取整块桌面，含本窗口',
      'keep.on': '存一份',
      'keep.onHint': '另存到图片文件夹，之后还能找到',
      'keep.off': '不存',
      'keep.offHint': '只进输入框，发完就没了',
      'footer.hint': '框好或截完，图片直接进输入框；Esc 取消',
      'error.command': '截图命令执行失败',
      'error.read': '读取截图文件失败',
      'error.editor': '找不到输入框，截图未能插入',
      'saved.notice': '已存到',
    }

    /** English copy, checked complete against the zh key set. */
    const en = {
      'button.label': 'Screenshot',
      'button.busy': 'Capturing…',
      'group.region': 'Region',
      'group.full': 'Full screen',
      'action.hide': 'Hide this window',
      'action.plain': 'As it is',
      'action.regionHideHint': 'Drag a rectangle; this window is stowed first',
      'action.regionPlainHint': 'Drag a rectangle; this window stays',
      'action.fullHideHint': 'Whole desktop; this window is stowed first',
      'action.fullPlainHint': 'Whole desktop, this window included',
      'keep.on': 'Keep a copy',
      'keep.onHint': 'Saved to Pictures so you can find it later',
      'keep.off': 'Do not keep',
      'keep.offHint': 'Goes to the composer only; gone after you send',
      'footer.hint': 'The shot goes straight into the composer; Esc cancels',
      'error.command': 'Screenshot command failed',
      'error.read': 'Could not read the captured image',
      'error.editor': 'Composer editor not found; the shot was not inserted',
      'saved.notice': 'Saved to',
    }

    /** localStorage key remembering the user's keep/do-not-keep choice. */
    const KEEP_KEY = 'dsh-screenshot.keep'

    /** Read the remembered keep choice; default false (do not accumulate files). */
    function readKeep() {
      try {
        return window.localStorage.getItem(KEEP_KEY) === '1'
      } catch {
        return false
      }
    }

    /** Remember the keep choice across sessions. */
    function writeKeep(value) {
      try {
        window.localStorage.setItem(KEEP_KEY, value ? '1' : '0')
      } catch {
        // Private mode: the choice just does not persist.
      }
    }

    /** Menu layout: two capture scopes, each with a hide switch. */
    const MENU = [
      {
        key: 'region',
        caption: 'group.region',
        mode: 'region',
        items: [
          { hide: true, title: 'action.hide', hint: 'action.regionHideHint' },
          { hide: false, title: 'action.plain', hint: 'action.regionPlainHint' },
        ],
      },
      {
        key: 'full',
        caption: 'group.full',
        mode: 'full',
        items: [
          { hide: true, title: 'action.hide', hint: 'action.fullHideHint' },
          { hide: false, title: 'action.plain', hint: 'action.fullPlainHint' },
        ],
      },
    ]

    const CSS = `
.dsh-shot-root { position: relative; display: inline-flex; align-items: center; }
.dsh-shot-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; margin: 0;
  border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; transition: background-color .12s, color .12s;
}
.dsh-shot-button:hover:not(:disabled),
.dsh-shot-button[data-open="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-shot-button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dsh-shot-button:disabled { cursor: default; opacity: .55; }
.dsh-shot-glyph { width: 16px; height: 16px; display: block; }
.dsh-shot-spin { animation: dsh-shot-rotate 1s linear infinite; transform-origin: 50% 50%; }
@keyframes dsh-shot-rotate { to { transform: rotate(360deg); } }
.dsh-shot-menu {
  position: fixed; z-index: 2147483000; width: 272px; box-sizing: border-box;
  padding: 4px; border: .5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
  font-size: 13px; line-height: 20px;
}
.dsh-shot-caption {
  padding: 6px 8px 2px; color: var(--dsw-alias-label-tertiary);
  font-size: 10px; font-weight: 500; letter-spacing: .04em;
}
.dsh-shot-sep { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-l1); }
.dsh-shot-item {
  display: flex; align-items: flex-start; gap: 8px; width: 100%;
  padding: 6px 8px; margin: 0; border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.dsh-shot-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-shot-item:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.dsh-shot-itemGlyph { flex: none; width: 16px; height: 16px; margin-top: 2px; color: var(--dsw-alias-label-secondary); }
.dsh-shot-itemText { display: flex; flex-direction: column; min-width: 0; }
.dsh-shot-itemTitle { font-weight: 500; white-space: nowrap; }
.dsh-shot-itemHint { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; }
.dsh-shot-footer {
  padding: 4px 8px 6px; color: var(--dsw-alias-label-tertiary);
  font-size: 11px; line-height: 16px;
}
.dsh-shot-notice {
  position: fixed; z-index: 2147483000; max-width: 340px; box-sizing: border-box;
  padding: 6px 9px; border: .5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-state-error-primary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
  font-size: 12px; line-height: 18px;
}
.dsh-shot-toast {
  position: fixed; z-index: 2147483000; max-width: 340px; box-sizing: border-box;
  padding: 6px 9px; border: .5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-secondary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
  font-size: 12px; line-height: 18px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-shot-keep {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 6px 8px;
}
.dsh-shot-keepLabel { display: flex; flex-direction: column; min-width: 0; }
.dsh-shot-switch {
  flex: none; position: relative; width: 34px; height: 20px; padding: 0; margin: 0;
  border: 0; border-radius: 999px; cursor: pointer;
  background: var(--dsw-alias-interactive-bg-hover);
  transition: background-color .15s;
}
.dsh-shot-switch[data-on="true"] { background: var(--dsw-alias-state-business-primary); }
.dsh-shot-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dsh-shot-switchKnob {
  position: absolute; top: 3px; left: 3px; width: 14px; height: 14px;
  border-radius: 50%; background: #fff;
  transition: transform .15s;
}
.dsh-shot-switch[data-on="true"] .dsh-shot-switchKnob { transform: translateX(14px); }
`

    /** Camera glyph: full-screen capture. */
    function CameraGlyph({ off = false, className }) {
      return h(
        'svg',
        {
          className,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M2.2 5.4h2.1l1.1-1.6h5.2l1.1 1.6h2.1a.9.9 0 0 1 .9.9v6a.9.9 0 0 1-.9.9H2.2a.9.9 0 0 1-.9-.9v-6a.9.9 0 0 1 .9-.9Z' }),
        h('circle', { cx: 8, cy: 9.2, r: 2.3 }),
        off ? h('path', { d: 'M1.6 1.6l12.8 12.8' }) : null,
      )
    }

    /** Dashed frame glyph: region capture. */
    function RegionGlyph({ className }) {
      return h(
        'svg',
        {
          className,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M2.2 5.4V3.5a1.3 1.3 0 0 1 1.3-1.3h1.9' }),
        h('path', { d: 'M10.6 2.2h1.9a1.3 1.3 0 0 1 1.3 1.3v1.9' }),
        h('path', { d: 'M13.8 10.6v1.9a1.3 1.3 0 0 1-1.3 1.3h-1.9' }),
        h('path', { d: 'M5.4 13.8H3.5a1.3 1.3 0 0 1-1.3-1.3v-1.9' }),
        h('path', { d: 'M5.6 5.6h4.8v4.8H5.6z', strokeDasharray: '1.6 1.4' }),
      )
    }

    /** Spinner shown while the Host is capturing. */
    function SpinnerGlyph({ className }) {
      return h(
        'svg',
        { className, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 8, cy: 8, r: 5.4, stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.25 }),
        h('path', { d: 'M8 2.6a5.4 5.4 0 0 1 5.4 5.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      )
    }

    /** The composer's Lexical root: the paste intake the composer itself installs. */
    function findEditor() {
      const editor =
        document.querySelector('[data-lexical-editor="true"]') ??
        document.querySelector('[contenteditable="true"]')
      return editor instanceof HTMLElement ? editor : null
    }

    /**
     * Hand the PNG to the composer exactly like a pasted image: one synthetic
     * ClipboardEvent carrying a File, dispatched on the editor root.
     */
    function pastePng(bytes, t) {
      const editor = findEditor()
      if (editor === null) throw new Error(t('error.editor'))
      const file = new File([bytes], 'screenshot.png', { type: 'image/png' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      const event = new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      })
      editor.dispatchEvent(event)
    }

    /** Read a Remote response, turning `{ ok: false }` into a thrown error. */
    function unwrap(result, what) {
      if (result === undefined || result === null) throw new Error(`${what}: no response`)
      if (result.ok !== true) {
        const error = result.error
        throw new Error(`${what}: ${error?.message ?? error?.code ?? 'request failed'}`)
      }
      return result.value
    }

    /** Unwrap the bytes of a workspace file read. */
    function bytesOf(value) {
      const data = value?.data
      if (data instanceof Uint8Array) return data
      if (data instanceof ArrayBuffer) return new Uint8Array(data)
      if (Array.isArray(data)) return new Uint8Array(data)
      throw new Error('screenshot: the captured file came back empty')
    }

    /**
     * Build the slot component bound to this plugin's Remote face and copy.
     * @param remote - Client Remote (commands + workspaceFiles namespaces).
     * @param t - locale translator for the `screenshot` namespace.
     */
    function createControl(remote, t) {
      return function ScreenshotControl(props) {
        const sessionId = props?.sessionId
        const [open, setOpen] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        const [saved, setSaved] = React.useState(null)
        const [anchor, setAnchor] = React.useState(null)
        const [keep, setKeep] = React.useState(readKeep)
        const buttonRef = React.useRef(null)
        const menuRef = React.useRef(null)
        const aliveRef = React.useRef(true)

        React.useEffect(() => {
          aliveRef.current = true
          return () => {
            aliveRef.current = false
          }
        }, [])

        React.useEffect(() => {
          if (error === null) return undefined
          const timer = setTimeout(() => setError(null), NOTICE_MS)
          return () => clearTimeout(timer)
        }, [error])

        React.useEffect(() => {
          if (saved === null) return undefined
          const timer = setTimeout(() => setSaved(null), NOTICE_MS)
          return () => clearTimeout(timer)
        }, [saved])

        React.useEffect(() => {
          if (!open) return undefined
          const onPointerDown = (event) => {
            const target = event.target
            if (target instanceof Node) {
              // The menu lives in a portal, so it is not inside the button subtree.
              if (buttonRef.current?.contains(target) === true) return
              if (menuRef.current?.contains(target) === true) return
            }
            setOpen(false)
          }
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false)
          }
          const onLayout = () => setOpen(false)
          document.addEventListener('mousedown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('resize', onLayout)
          window.addEventListener('scroll', onLayout, true)
          return () => {
            document.removeEventListener('mousedown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('resize', onLayout)
            window.removeEventListener('scroll', onLayout, true)
          }
        }, [open])

        const measure = () => {
          const rect = buttonRef.current?.getBoundingClientRect()
          if (rect === undefined) return null
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - 284))
          return { left, bottom: window.innerHeight - rect.top + 6 }
        }

        const toggle = () => {
          if (busy) return
          if (open) {
            setOpen(false)
            return
          }
          setAnchor(measure())
          setOpen(true)
        }

        const capture = React.useCallback(
          async (mode, hide) => {
            if (sessionId === undefined || busy) return
            setOpen(false)
            setBusy(true)
            setError(null)
            setSaved(null)
            const controller = new AbortController()
            try {
              const line = `/screenshot ${JSON.stringify({ mode, hide, keep, title: document.title })}`
              const execution = unwrap(
                await remote.commands.execute(sessionId, line, [], controller.signal),
                t('error.command'),
              )
              if (execution === undefined) throw new Error(t('error.command'))
              if (execution?.result?.kind === 'error') {
                throw new Error(String(execution.result.text ?? t('error.command')))
              }
              // The Host reports a kept copy as "…，已存到 `<path>`".
              const text = String(execution.result?.text ?? '')
              const savedPath = /`([^`]+)`/.exec(text)?.[1]
              if (savedPath !== undefined && savedPath !== '') setSaved(savedPath.trim())
              // Esc in the region picker settles the command successfully.
              if (text.trim() === CANCELLED) return
              const file = unwrap(
                await remote.workspaceFiles.readBytes(sessionId, DRAFT_PATH, {}, controller.signal),
                t('error.read'),
              )
              pastePng(bytesOf(file), t)
            } catch (reason) {
              if (!aliveRef.current) return
              setError(reason instanceof Error ? reason.message : String(reason))
            } finally {
              if (aliveRef.current) setBusy(false)
            }
          },
          [sessionId, busy, keep],
        )

        const chooseKeep = (value) => {
          setKeep(value)
          writeKeep(value)
        }

        if (sessionId === undefined) return null

        const rows = []
        for (const group of MENU) {
          if (rows.length > 0) rows.push(h('div', { key: `sep-${group.key}`, className: 'dsh-shot-sep' }))
          rows.push(h('div', { key: `cap-${group.key}`, className: 'dsh-shot-caption' }, t(group.caption)))
          for (const item of group.items) {
            const key = `${group.key}-${item.hide ? 'hide' : 'plain'}`
            rows.push(
              h(
                'button',
                {
                  key,
                  type: 'button',
                  role: 'menuitem',
                  className: 'dsh-shot-item',
                  onClick: () => capture(group.mode, item.hide),
                },
                group.mode === 'region'
                  ? h(RegionGlyph, { className: 'dsh-shot-itemGlyph' })
                  : h(CameraGlyph, { className: 'dsh-shot-itemGlyph', off: item.hide }),
                h(
                  'span',
                  { className: 'dsh-shot-itemText' },
                  h('span', { className: 'dsh-shot-itemTitle' }, t(item.title)),
                  h('span', { className: 'dsh-shot-itemHint' }, t(item.hint)),
                ),
              ),
            )
          }
        }
        // Keep switch: applies to whichever capture item is clicked next.
        rows.push(h('div', { key: 'sep-keep', className: 'dsh-shot-sep' }))
        rows.push(
          h(
            'div',
            { key: 'keep', className: 'dsh-shot-keep', role: 'group', 'aria-label': t('keep.on') },
            h(
              'span',
              { className: 'dsh-shot-keepLabel' },
              h('span', { className: 'dsh-shot-itemTitle' }, t(keep ? 'keep.on' : 'keep.off')),
              h('span', { className: 'dsh-shot-itemHint' }, t(keep ? 'keep.onHint' : 'keep.offHint')),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                className: 'dsh-shot-switch',
                'aria-checked': keep,
                'aria-label': t(keep ? 'keep.on' : 'keep.off'),
                'data-on': keep ? 'true' : 'false',
                onClick: () => chooseKeep(!keep),
              },
              h('span', { className: 'dsh-shot-switchKnob' }),
            ),
          ),
        )
        rows.push(h('div', { key: 'footer', className: 'dsh-shot-footer' }, t('footer.hint')))

        const menu = open && anchor !== null
          ? ReactDOM.createPortal(
              h(
                'div',
                {
                  ref: menuRef,
                  className: 'dsh-shot-menu',
                  role: 'menu',
                  style: { left: anchor.left, bottom: anchor.bottom },
                },
                rows,
              ),
              document.body,
            )
          : null

        const notice = error !== null && anchor !== null
          ? ReactDOM.createPortal(
              h(
                'div',
                { className: 'dsh-shot-notice', role: 'status', style: { left: anchor.left, bottom: anchor.bottom } },
                error,
              ),
              document.body,
            )
          : null

        const savedNotice = error === null && saved !== null && anchor !== null
          ? ReactDOM.createPortal(
              h(
                'div',
                {
                  className: 'dsh-shot-toast',
                  role: 'status',
                  style: { left: anchor.left, bottom: anchor.bottom },
                  title: saved,
                },
                `${t('saved.notice')} ${saved}`,
              ),
              document.body,
            )
          : null

        return h(
          'span',
          { className: 'dsh-shot-root' },
          h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
          h(
            'button',
            {
              ref: buttonRef,
              type: 'button',
              className: 'dsh-shot-button',
              'data-open': open ? 'true' : 'false',
              'aria-label': t('button.label'),
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              title: busy ? t('button.busy') : t('button.label'),
              disabled: busy,
              onClick: toggle,
            },
            busy
              ? h(SpinnerGlyph, { className: 'dsh-shot-glyph dsh-shot-spin' })
              : h(RegionGlyph, { className: 'dsh-shot-glyph' }),
          ),
          menu,
          notice,
          savedNotice,
        )
      }
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'remote.workspaceFiles'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-screenshot: dictionaries')
        } catch {
          // A reloaded generation may find the namespace already registered.
        }
        const t = ctx.locale.bind(NS)
        const Control = createControl(ctx.remote, t)
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.input.left', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.left',
                  id: 'dsh-screenshot',
                  order: 4,
                  locale: NS,
                  label: () => t('button.label'),
                },
                Control,
              ),
            ),
          'dsh-screenshot: composer control',
        )
      },
    }
  },
})

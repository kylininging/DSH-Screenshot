/**
 * Host half of the DSH screenshot bundle.
 *
 * Owns one operation — "capture the desktop to a PNG" — and exposes it twice:
 * the `/screenshot` session command (called by the composer button) and the
 * `screenshot` agent tool (called by the model).
 *
 * `capture.ps1` does the work: GDI grabs the whole virtual desktop, and for
 * `region` it freezes that image behind a full-screen picker. Hiding parks every
 * visible top-level window whose title matches off-screen before the freeze.
 *
 * The helper runs as a resident worker, preloaded when the plugin activates, so a
 * click pays one stdin round trip instead of a PowerShell cold start. A one-shot
 * `-File` invocation remains as the fallback when the worker cannot start.
 *
 * Nothing here accumulates: a capture always overwrites one fixed file, and the
 * workspace copy is deleted when the plugin unloads. The composer button can also
 * ask for the draft to be thrown away right after the client picks it up (`keep`
 * false), which is the default — the picture lives in the composer draft, not on disk.
 */
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, readdir, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPER = path.join(HERE, 'capture.ps1')

/** Workspace-relative directory the composer button reads its capture back from. */
const DRAFT_DIR = '.dsh-screenshots'
/** Fixed draft name: the client asks for this exact path through `workspaceFiles.readBytes`. */
const DRAFT_NAME = 'latest.png'
/** Every workspace directory a capture wrote into, removed when the plugin unloads. */
const draftDirs = new Set()
/**
 * Grace period before a "do not keep" draft is deleted. The client reads the bytes
 * within milliseconds; the delay only needs to cover a slow round trip.
 */
const DRAFT_TTL_MS = 15000
/** Window titles hidden by default when the caller hides the Harness window. */
const DEFAULT_TITLES = ['DeepSeek Harness']
/** Milliseconds to let the compositor drop a hidden window before grabbing pixels. */
const SETTLE_MS = 50
/** How long a capture may take before the helper is considered wedged. */
const CAPTURE_TIMEOUT_MS = 300_000

const POWERSHELL = ['powershell.exe', 'pwsh.exe']

/** Timeout/decode failures that must not be retried through the one-shot path. */
class CaptureFailure extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'CaptureFailure'
    this.code = code
  }
}

/** Parse the single JSON line a helper invocation prints. */
function parseResult(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{') && !entry.includes('"ready"'))
    .pop()
  if (line === undefined) throw new CaptureFailure('screenshot helper returned no result', 'protocol')
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new CaptureFailure('screenshot helper returned malformed output', 'protocol')
  }
  if (parsed.ok !== true) throw new CaptureFailure(parsed.error ?? 'screenshot helper failed', 'helper')
  return parsed
}

/** One-shot capture: start PowerShell, capture, exit. The fallback path. */
function runOnce(spec) {
  const request = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64')
  return new Promise((resolve, reject) => {
    const attempt = (index) => {
      if (index >= POWERSHELL.length) {
        reject(new CaptureFailure('no PowerShell executable was found', 'shell'))
        return
      }
      execFile(
        POWERSHELL[index],
        ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Request', request],
        { windowsHide: true, timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          if (error !== null && error !== undefined) {
            if (error.code === 'ENOENT') {
              attempt(index + 1)
              return
            }
            reject(new CaptureFailure(error.message, 'shell'))
            return
          }
          try {
            resolve(parseResult(stdout))
          } catch (failure) {
            reject(failure)
          }
        },
      )
    }
    attempt(0)
  })
}

/**
 * Put back windows a crashed or timed-out capture may have left hidden.
 * Fire and forget: the caller has already failed the request.
 */
function restoreHidden(titles) {
  if (!Array.isArray(titles) || titles.length === 0) return
  const payload = Buffer.from(JSON.stringify({ titles, ownerPid: process.pid }), 'utf8').toString('base64')
  try {
    execFile(
      POWERSHELL[0],
      ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Restore', payload],
      { windowsHide: true, timeout: 15_000 },
      () => {},
    )
  } catch {
    // Best effort only.
  }
}

/**
 * Resident helper process. Starts once (preloaded at activation) and serves one
 * capture per stdin line, so the freeze happens as soon as the click arrives.
 */
class CaptureWorker {
  constructor(helper) {
    this.helper = helper
    this.child = null
    this.buffer = ''
    this.ready = null
    this.pending = null
    this.chain = Promise.resolve()
    this.shellIndex = 0
    this.disposed = false
  }

  /** Resolve once the worker printed its ready line, spawning it if needed. */
  start() {
    if (this.ready !== null && this.child !== null && this.child.exitCode === null) return this.ready
    this.buffer = ''
    this.child = null
    const shell = POWERSHELL[this.shellIndex] ?? POWERSHELL[0]
    const child = spawn(
      shell,
      ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helper, '-Worker'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    )
    this.child = child
    this.ready = new Promise((resolve, reject) => {
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.child = null
        this.ready = null
        reject(error)
      }
      const timer = setTimeout(() => fail(new CaptureFailure('screenshot helper did not start', 'shell')), 30_000)
      /**
       * Readiness succeeded: stop the start timer. Without this the timer fires
       * 30 s later, nulls this.child, and the next click cold-starts a whole
       * PowerShell (~1.5 s) while the live worker is orphaned forever.
       */
      const succeed = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      }
      child.once('error', (error) => fail(new CaptureFailure(error.message, 'shell')))
      child.once('exit', () => {
        // A stale child (already replaced by a respawn) must not clobber the
        // request that the current child is serving.
        if (this.child !== child) return
        const pending = this.pending
        this.pending = null
        if (pending !== null) {
          clearTimeout(pending.timer)
          restoreHidden(pending.titles)
          pending.reject(new CaptureFailure('screenshot helper exited', 'shell'))
        }
        fail(new CaptureFailure('screenshot helper exited', 'shell'))
      })
      child.stdin.on('error', () => {})
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        this.buffer += chunk
        let index = this.buffer.indexOf('\n')
        while (index >= 0) {
          const line = this.buffer.slice(0, index).trim()
          this.buffer = this.buffer.slice(index + 1)
          if (line !== '') this.dispatch(line, succeed, fail)
          index = this.buffer.indexOf('\n')
        }
      })
    })
    this.ready.catch(() => {})
    return this.ready
  }

  /** Route one helper line to the readiness gate or the in-flight request. */
  dispatch(line, readyResolve, readyReject) {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (parsed?.ready === true) {
      readyResolve(parsed)
      return
    }
    const pending = this.pending
    if (pending === null) return
    this.pending = null
    clearTimeout(pending.timer)
    if (parsed?.ok === true) pending.resolve(parsed)
    else pending.reject(new CaptureFailure(parsed?.error ?? 'screenshot helper failed', 'helper'))
    void readyReject
  }

  /** Queue one capture; requests are serialized because the helper is single-file. */
  run(spec) {
    const next = this.chain.then(() => this.runOnce(spec))
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async runOnce(spec) {
    if (this.disposed) throw new CaptureFailure('screenshot plugin is unloaded', 'shell')
    await this.start()
    const child = this.child
    if (child === null) throw new CaptureFailure('screenshot helper is not running', 'shell')
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        // The helper may be blocked inside the picker with the window hidden.
        restoreHidden(spec.titles)
        this.stop()
        reject(new CaptureFailure('screenshot helper timed out', 'timeout'))
      }, CAPTURE_TIMEOUT_MS)
      this.pending = { resolve, reject, timer, titles: spec.titles }
      child.stdin.write(`${JSON.stringify(spec)}\n`)
    })
  }

  stop() {
    const child = this.child
    this.child = null
    this.ready = null
    this.buffer = ''
    if (child === null) return
    try {
      child.stdin.end('exit\n')
    } catch {
      // The pipe is already gone; fall through to the kill.
    }
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already exited.
      }
    }, 400).unref?.()
  }

  dispose() {
    this.disposed = true
    this.stop()
  }
}

/** Run the resident helper; fall back to a one-shot process only if it cannot start. */
async function runCapture(out, titles, mode) {
  // ownerPid: only park windows that belong to THIS process tree. Without it a
  // browser tab titled "… — DeepSeek Harness" would be stowed too.
  const spec = { out, titles, settleMs: SETTLE_MS, mode, ownerPid: process.pid }
  try {
    return await worker.run(spec)
  } catch (error) {
    if (error instanceof CaptureFailure && error.code === 'shell' && !workerRunning()) {
      return await runOnce(spec)
    }
    throw error
  }
}

/** Resolve the working directory that owns the composer's draft screenshot. */
function workingDirectoryOf(ctx, agent) {
  try {
    const service = ctx.get?.('workingDirectory')
    if (service !== undefined) {
      const directory = service.get(agent.session)
      if (typeof directory === 'string' && directory.length > 0) return directory
    }
  } catch {
    // Fall through to the session header below.
  }
  const fromHeader = agent?.session?.header?.cwd
  return typeof fromHeader === 'string' && fromHeader.length > 0 ? fromHeader : process.cwd()
}

/** Titles to hide: the caller's page title first, then the product window titles. */
function hideTitles(title) {
  const titles = []
  if (typeof title === 'string' && title.trim().length > 0) titles.push(title.trim())
  for (const fallback of DEFAULT_TITLES) titles.push(fallback)
  return [...new Set(titles)]
}

/** Bumped per draft directory so a pending discard cannot delete a newer capture. */
const draftGenerations = new Map()

/** Schedule removal of a draft the caller does not want to keep. */
function scheduleDiscard(out, generation) {
  const timer = setTimeout(() => {
    if (draftGenerations.get(out) !== generation) return
    draftGenerations.delete(out)
    const directory = path.dirname(out)
    unlink(out)
      // Drop the now-empty folder too, so a capture leaves no trace at all.
      .then(() => rmdir(directory))
      .catch(() => {})
  }, DRAFT_TTL_MS)
  timer.unref?.()
}

/**
 * Where an explicitly kept capture lands. `%USERPROFILE%\Pictures\DSH Screenshots`
 * is the folder users already look in for screenshots; it falls back to the
 * workspace when the profile has no Pictures directory.
 */
function keepFolder(fallback) {
  const profile = process.env.USERPROFILE ?? process.env.HOME
  if (typeof profile === 'string' && profile.length > 0) return path.join(profile, 'Pictures', 'DSH Screenshots')
  return path.join(fallback, 'DSH Screenshots')
}

/** Timestamped name for a kept capture: sortable, second precision, no colons. */
function stampName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `screenshot-${day}-${time}.png`
}

/** Copy a finished draft to the keep folder and return its absolute path. */
async function keepCopy(source, fallback) {
  const directory = keepFolder(fallback)
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, stampName())
  await copyFile(source, target)
  return target
}

/** Capture into the session's draft folder and describe the result for the UI. */
async function captureForDraft(ctx, agent, options) {
  const workspace = workingDirectoryOf(ctx, agent)
  const directory = path.join(workspace, DRAFT_DIR)
  await mkdir(directory, { recursive: true })
  draftDirs.add(directory)
  // Keep exactly one file: drop anything an earlier version or a crashed run left.
  try {
    for (const name of await readdir(directory)) {
      if (name !== DRAFT_NAME) await unlink(path.join(directory, name)).catch(() => {})
    }
  } catch {
    // A missing directory is fine; the write below recreates it.
  }
  const out = path.join(directory, DRAFT_NAME)
  const mode = options.mode === 'region' ? 'region' : 'full'
  const keep = options.keep === true
  const generation = (draftGenerations.get(out) ?? 0) + 1
  draftGenerations.set(out, generation)
  const result = await runCapture(out, options.hide === true ? hideTitles(options.title) : [], mode)
  if (result.cancelled === true) return { ...result, keep: false }
  // The draft is only transport: the client reads it before the command settles, so
  // it is always dropped afterwards. Keeping a copy is the opt-in extra.
  const saved = keep ? await keepCopy(out, workspace).catch(() => null) : null
  scheduleDiscard(out, generation)
  return {
    ...result,
    keep: saved !== null,
    saved,
    draft: path.join(DRAFT_DIR, DRAFT_NAME).replace(/\\/g, '/'),
  }
}

/**
 * Remove the draft capture this process wrote. Only the one fixed file and the
 * directory it owns are touched: a kept `saved/` sibling must never be swept up.
 */
function discardDrafts() {
  for (const directory of draftDirs) {
    const draft = path.join(directory, DRAFT_NAME)
    unlink(draft)
      .then(() => rmdir(directory))
      .catch(() => {})
  }
  draftDirs.clear()
}

/** Capture into a scratch file and describe the result for the model. */
async function captureForTool(options) {
  const directory = path.join(tmpdir(), 'dsh-screenshot')
  await mkdir(directory, { recursive: true })
  // The model may be handed this path and read it later in the same turn, so it is
  // never deleted underneath it: one fixed name, overwritten by the next capture.
  const out = path.join(directory, 'shot.png')
  const result = await runCapture(out, options.hide === true ? hideTitles(options.title) : [], 'full')
  return { ...result, tmp: true }
}

/** Parse the command's free-form input: an optional JSON body, else a bare word. */
function parseRequest(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (text === '') return {}
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  const [head, ...rest] = text.split(/\s+/)
  const words = rest.filter((word) => word !== 'keep' && word !== 'save')
  return {
    hide: head === 'hide' || head === '隐藏',
    mode: head === 'region' ? 'region' : 'full',
    keep: rest.length !== words.length,
    title: words.join(' '),
  }
}

let worker = null
let workerPrewarm = null

/** True while the resident helper process is still alive. */
function workerRunning() {
  return worker !== null && worker.child !== null && worker.child.exitCode === null
}

export const inject = ['commands', 'tools']

export function apply(ctx) {
  // A previous instance may still hold a live worker (e.g. the profile re-applied
  // this bundle without disposing the old effect first). Take it down now: its
  // disposer below reads the shared module variable, so it could not kill it later.
  worker?.dispose()
  const instance = new CaptureWorker(HELPER)
  worker = instance
  workerPrewarm = instance.start().catch(() => null)
  ctx.effect(() => () => {
    // Dispose THIS instance, not whatever `worker` points to now: a reload may
    // already have replaced it, and disposing the module variable would kill the
    // new instance while leaking this one's process.
    if (worker === instance) {
      workerPrewarm = null
      worker = null
    }
    instance.dispose()
    discardDrafts()
  }, 'dsh-screenshot: capture worker')

  ctx.effect(() =>
    ctx.commands.register({
      name: 'screenshot',
      description: 'Capture the screen into the composer draft (the composer button runs this).',
      input: {
        hint: '{"mode":"region","hide":true,"keep":false}',
      },
      recordInput: false,
      async handler({ agent, rawInput, signal }) {
        try {
          const request = parseRequest(rawInput)
          const result = await captureForDraft(ctx, agent, request)
          if (signal?.aborted === true) return { kind: 'success', text: 'cancelled' }
          if (result.cancelled === true) return { kind: 'success', text: 'cancelled' }
          const scope = request.mode === 'region' ? '区域' : '整屏'
          const hidden = result.hidden > 0 ? `，已隐藏 ${result.hidden} 个窗口` : ''
          // The saved path travels in backticks: the client needs it for its toast, and a
          // locale-independent delimiter keeps that parse from depending on the wording.
          const kept = typeof result.saved === 'string' ? `，已存到 \`${result.saved}\`` : ''
          return { kind: 'success', text: `已截图 ${result.width}×${result.height}（${scope}${hidden}${kept}）` }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'screenshot',
      description:
        'Capture the whole desktop (all monitors) to a PNG file and return its path. '
        + 'The file can be inspected with read_image. Set hide to true to minimize the '
        + 'DeepSeek Harness window first, so the window does not cover the capture. '
        + 'Region selection needs a human drag, so it is offered only by the composer button.',
      parameters: {
        type: 'object',
        properties: {
          hide: {
            type: 'boolean',
            description: 'Hide the Harness window (and matching windows) while capturing. Defaults to false.',
          },
          title: {
            type: 'string',
            description: 'Extra top-level window title to hide; matching is a case-sensitive substring test.',
          },
          keep: {
            type: 'boolean',
            description:
              'Copy the capture into the user Pictures folder so it survives. Defaults to false: '
              + 'the file is a scratch file under the temp directory and is replaced by the next capture.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            width: { type: 'number' },
            height: { type: 'number' },
            hidden: { type: 'number' },
            ms: { type: 'number' },
            saved: { type: 'string' },
          },
          required: ['path', 'width', 'height', 'hidden', 'ms'],
          additionalProperties: false,
        },
        render(_args, value) {
          const kept = typeof value.saved === 'string' ? ` (kept at ${value.saved})` : ''
          return [
            {
              type: 'text',
              text: `captured ${value.width}x${value.height}px in ${value.ms}ms${value.hidden > 0 ? ` (hid ${value.hidden} window(s))` : ''} -> ${value.path}${kept}`,
            },
          ]
        },
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const result = await captureForTool({ hide: args?.hide === true, title: args?.title })
        const saved = args?.keep === true ? await keepCopy(result.path, tmpdir()).catch(() => null) : null
        return {
          path: result.path,
          width: result.width,
          height: result.height,
          hidden: result.hidden,
          ms: result.ms ?? 0,
          ...(saved === null ? {} : { saved }),
        }
      },
    }),
  )
}

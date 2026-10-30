/**
 * M0 spike host half: mounts probe routes plus a working-directory projection
 * listener, so the question "can a plugin rewrite the cwd the model sees?"
 * is answered by the real Host rather than by reading source.
 *
 * The probe routes are intentionally small and loopback-only. Each one exists
 * to settle exactly one question; `docs/design/ui-design.md` §9.1 records the
 * verdict each route produced.
 * @module @dsh-teleport/spike
 */

/** Stable cordis plugin name. */
export const name = 'teleport-spike'

/** Services required before the probe routes can mount. */
export const inject = [
  'webServer',
  'systemPrompt',
  'agents',
  'workingDirectory',
  'directoryPicker',
  'fs',
  'tools',
  'agentPresets',
]

/** Set by the projection listener after it rewrote a context text. */
const projectionHits = []

/** Marker prefix of the probe workspace, used to build realistic UNC paths. */
const PROBE_UNC_ROOT = '\\\\wsl.localhost\\ubuntu_dev'

/** Loopback-only guard: the spike routes answer the local browser only. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Write one JSON body. */
function writeJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(value))
}

/**
 * Rewrite a Windows UNC working directory into its Linux form.
 * @param text - the assembled context text.
 * @returns the projected text, or the input when it is not a UNC path.
 */
function projectUncWorkingDirectory(text) {
  const match = /^Current working directory: ("(?:[^"\\]|\\.)*")\.$/.exec(text)
  if (match === null) return text
  let cwd
  try { cwd = JSON.parse(match[1]) } catch { return text }
  const unc = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$/.exec(cwd)
  if (unc === null) return text
  return 'Current working directory: "/' + unc[2].split('\\').join('/') + '".'
}

/**
 * Rewrite the workspace path inside the sandbox policy clause. The policy
 * owner renders it separately from the working-directory clause
 * (packages/sandbox/sandbox-policy/src/index.ts:42-56), so a projection that
 * only touches working-directory:current leaves a second UNC sighting in the
 * prompt.
 * @param text - the assembled policy text.
 * @returns the projected text, or the input when no UNC workspace is quoted.
 */
function projectUncSandboxPolicy(text) {
  const marker = 'the session workspace: '
  const at = text.indexOf(marker)
  if (at < 0) return text
  const quoted = /^("(?:[^"\\]|\\.)*")/.exec(text.slice(at + marker.length))
  if (quoted === null) return text
  let cwd
  try { cwd = JSON.parse(quoted[1]) } catch { return text }
  const unc = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$/.exec(cwd)
  if (unc === null) return text
  const projected = JSON.stringify('/' + unc[2].split('\\').join('/'))
  return text.slice(0, at + marker.length) + projected + text.slice(at + marker.length + quoted[1].length)
}

/**
 * Mount the probe routes and the projection listener.
 * @param ctx - host context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    const contribution = result.contexts.find(entry => entry.name === 'working-directory:current')
    if (contribution !== undefined) {
      const before = contribution.text
      const after = projectUncWorkingDirectory(before)
      if (after !== before) {
        contribution.text = after
        projectionHits.push({ name: 'working-directory:current', sessionId: context.agent?.session?.id ?? null, before, after })
      }
    }
    const policy = result.contexts.find(entry => entry.name === 'sandbox:policy')
    if (policy !== undefined) {
      const before = policy.text
      const after = projectUncSandboxPolicy(before)
      if (after !== before) {
        policy.text = after
        projectionHits.push({ name: 'sandbox:policy', sessionId: context.agent?.session?.id ?? null, before, after })
      }
    }
    return result
  }, { prepend: true }), 'teleport-spike: working-directory projection')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/teleport-spike/ping',
    handler: (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
      writeJson(res, 200, { ok: true, half: 'host', plugin: 'teleport-spike' })
    },
  }), 'teleport-spike: probe route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/teleport-spike/prompt',
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
      try {
        const agents = ctx.agents.list()
        const rows = []
        for (const agent of agents) {
          const session = agent.session
          const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent.scope })
          const working = assembly.contexts.find(entry => entry.name === 'working-directory:current')
          rows.push({
            sessionId: session.id,
            headerCwd: session.header?.cwd ?? null,
            projectedCwd: ctx.workingDirectory.get(session),
            contextText: working?.text ?? null,
            contexts: assembly.contexts.map(entry => ({ name: entry.name, text: entry.text })),
          })
        }
        writeJson(res, 200, { ok: true, agentCount: agents.length, projectionHits, agents: rows })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: String(error), stack: String(error?.stack ?? '') })
      }
    },
  }), 'teleport-spike: prompt probe route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/teleport-spike/picker',
    handler: (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
      const capability = ctx.directoryPicker.capability()
      writeJson(res, 200, { ok: true, kind: capability.kind, keys: Object.keys(capability) })
    },
  }), 'teleport-spike: picker capability route')

  // Teleport's own browse route: the directoryPicker seam is host-local and its
  // capability kind is fixed at boot (native on a loopback Windows host), so a
  // remote backend's listing cannot go through it. This route proves the plugin
  // can serve its own listing with the same shape the client needs.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/teleport-spike/list',
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const target = url.searchParams.get('path') ?? process.cwd()
        const fs = await import('node:fs/promises')
        const dirents = await fs.readdir(target, { withFileTypes: true })
        writeJson(res, 200, {
          ok: true,
          path: target,
          entries: dirents.slice(0, 200).map(d => ({ name: d.name, kind: d.isDirectory() ? 'directory' : 'file' })),
          truncated: dirents.length > 200,
        })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: String(error) })
      }
    },
  }), 'teleport-spike: own browse route')

  // Raw filesystem resolution, separate from tool dispatch: this is how the
  // spike established that a rooted POSIX path resolves against the cwd's own
  // root (a UNC share for a WSL workspace), which is what makes the prompt
  // projection safe without any argument rewriting.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/teleport-spike/fs',
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const target = url.searchParams.get('path') ?? process.cwd()
      const cwd = url.searchParams.get('cwd') ?? undefined
      const rows = {}
      try {
        const resolved = await ctx.fs.resolve(target, cwd === undefined ? undefined : { cwd })
        rows.processPath = ctx.fs.processPath(resolved)
        rows.displayPath = resolved.displayPath
        const info = await ctx.fs.stat(resolved)
        rows.stat = info === undefined ? null : { type: info.type, size: info.size ?? null }
      } catch (error) {
        rows.error = String(error)
      }
      writeJson(res, 200, { ok: rows.error === undefined, path: target, ...rows })
    },
  }), 'teleport-spike: fs probe route')

  // Which tools does the registry actually expose in each scope? The web
  // surface disables `tool-fs` on the host plane on purpose
  // (packages/bundle/web-app/cordis.patch.yml:504) and lets every session mount
  // a preset instead, so a host-plane dispatch resolves almost nothing.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/teleport-spike/tools',
    handler: (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
      const agents = ctx.agents.list()
      writeJson(res, 200, {
        ok: true,
        agentCount: agents.length,
        global: ctx.tools.schemas().map(schema => schema.name),
        scoped: agents.map(agent => ({
          sessionId: agent.session.id,
          names: ctx.tools.schemas(agent).map(schema => schema.name),
        })),
      })
    },
  }), 'teleport-spike: tool inventory route')

  // A real dispatch through the tool registry inside a mounted preset realm.
  // This is the only route that reproduces what a model-issued call goes
  // through: scoped tool resolution, then the tool body reading the arguments.
  // It is what proved that a projected POSIX path works with no rewriting.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/teleport-spike/call',
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
      let handle
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const filePath = url.searchParams.get('path') ?? '/'
        const toolName = url.searchParams.get('tool') ?? 'read'
        const presetId = url.searchParams.get('preset') ?? 'cordis'
        handle = await ctx.agents.create({
          sessionId: 'teleport-probe-' + Date.now().toString(36),
          meta: { cwd: PROBE_UNC_ROOT + '\\home\\hui\\workspace', agentPreset: presetId },
          signal: new AbortController().signal,
          setup: async agentCtx => {
            const presets = agentCtx.get('agentPresets')
            if (presets === undefined) throw new Error('agentPresets service is not mounted')
            await presets.mount(agentCtx, presetId)
          },
        })
        const agent = handle.agent ?? handle
        const visibleTools = ctx.tools.schemas(agent).map(schema => schema.name)
        const sentArguments = { file_path: filePath }
        const result = await ctx.tools.execute({
          callId: 'teleport-probe-call-' + Date.now().toString(36),
          name: toolName,
          arguments: sentArguments,
          signal: new AbortController().signal,
          agent,
        })
        writeJson(res, 200, { ok: true, sentPath: filePath, visibleTools, result })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: String(error), stack: String(error?.stack ?? '') })
      } finally {
        try { await handle?.dispose?.() } catch { /* probe cleanup is best-effort */ }
      }
    },
  }), 'teleport-spike: real tool dispatch route')
}

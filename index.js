/** @typedef {import('pear-interface')} */
import Runtime from 'pear-electron'
import Bridge from 'pear-bridge'
import { startEngine, resolveFolder, startupConflictPolicies } from './lib/engine-manager.js'
import { EngineBridge } from './lib/engine-bridge.js'

Pear.updates((update) => {
  console.log('Application update available:', update)
})

// Serve the React app from web/dist/
const bridge = new Bridge({ mount: '/web/dist', waypoint: 'index.html' })
await bridge.ready()

const runtime = new Runtime()
const pipe = await runtime.start({ bridge })
pipe.on('close', () => Pear.exit())

// Engine state
let engine = null
let engineBridge = null
let store = null
let resolvedFolder = null
let currentStartupConflictPolicy = null
let removePushListener = null

// JSON-RPC over pipe
// Request:  { id, method: "get"|"post", params: { path, body?, query? } }
// Response: { id, result } or { id, error }
// Push:     { type, payload, timestamp } (same shape as WsMessage)

pipe.on('data', async (data) => {
  let request
  try {
    request = JSON.parse(Buffer.from(data).toString())
  } catch {
    return
  }

  if (!request.id) return

  const { id, method, params } = request
  const { path, body, query } = params || {}

  try {
    const result = await handleRequest(method, path, body, query)
    pipe.write(JSON.stringify({ id, result }))
  } catch (err) {
    pipe.write(JSON.stringify({ id, error: String(err) }))
  }
})

async function handleRequest (method, path, body, query) {
  if (method === 'get' && path === '/api/status') {
    if (engineBridge) return engineBridge.getStatus()
    return { state: 'setup', folder: null, startupConflictPolicy: null }
  }

  if (method === 'post' && path === '/api/setup') {
    if (engine) throw new Error('Already configured')
    const { folder, mode, inviteCode, startupConflictPolicy } = body || {}
    if (!folder || !mode) throw new Error('folder and mode are required')
    if (startupConflictPolicy && !startupConflictPolicies.includes(startupConflictPolicy)) {
      throw new Error('invalid startupConflictPolicy')
    }
    resolvedFolder = resolveFolder(folder)
    const result = await startEngine(resolvedFolder, mode, inviteCode, undefined, startupConflictPolicy)
    engine = result.engine
    store = result.store
    currentStartupConflictPolicy = result.startupConflictPolicy
    engineBridge = new EngineBridge(engine, resolvedFolder, currentStartupConflictPolicy)
    engineBridge.attach()
    removePushListener = engineBridge.addPushListener((msg) => {
      pipe.write(JSON.stringify(msg))
    })
    return { ok: true, writerKey: engine.getManifest().writerKey }
  }

  if (method === 'post' && path === '/api/invite') {
    if (!engine) throw new Error('Not configured')
    const inviteCode = await engine.getManifest().createInvite()
    return { inviteCode }
  }

  if (method === 'get' && path === '/api/files') {
    if (!engineBridge) return []
    return await engineBridge.getFiles()
  }

  if (method === 'get' && path === '/api/peers') {
    if (!engineBridge) return []
    return await engineBridge.getPeers()
  }

  if (method === 'get' && path === '/api/events') {
    const limit = parseInt(query?.limit ?? '100', 10)
    const offset = parseInt(query?.offset ?? '0', 10)
    return engineBridge ? engineBridge.getEvents(offset, limit) : []
  }

  if (method === 'post' && path === '/api/shutdown') {
    setImmediate(async () => {
      if (removePushListener) removePushListener()
      if (engineBridge) engineBridge.detach()
      if (engine) {
        await engine.stop()
        await engine.close()
      }
      if (store) await store.close()
      Pear.exit()
    })
    return { ok: true }
  }

  throw new Error(`Unknown route: ${method} ${path}`)
}

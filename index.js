/** @typedef {import('pear-interface')} */
import Runtime from 'pear-electron'
import Bridge from 'pear-bridge'
import { spawn as spawnProcess } from 'bare-subprocess'
import os from 'bare-os'
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

// JSON-RPC over pipe (newline-delimited JSON)
// Request:  { id, method: "get"|"post", params: { path, body?, query? } }
// Response: { id, result } or { id, error }
// Push:     { type, payload, timestamp } (same shape as WsMessage)

const PIPE_DEBUG = typeof Pear !== 'undefined' && Pear.config?.args?.includes('--pipe-debug')
function pipeLog (dir, summary, detail) {
  if (!PIPE_DEBUG) return
  const ts = new Date().toISOString().slice(11, 23)
  if (detail !== undefined) console.log(`[pipe:main ${ts}] ${dir} ${summary}`, typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200))
  else console.log(`[pipe:main ${ts}] ${dir} ${summary}`)
}

function pipeSend (obj) {
  pipe.write(JSON.stringify(obj) + '\n')
}

let pipeBuf = ''
pipe.on('data', (data) => {
  pipeBuf += Buffer.from(data).toString()
  let nl
  while ((nl = pipeBuf.indexOf('\n')) !== -1) {
    const line = pipeBuf.slice(0, nl)
    pipeBuf = pipeBuf.slice(nl + 1)
    if (line) handlePipeLine(line)
  }
})

async function handlePipeLine (line) {
  let request
  try {
    request = JSON.parse(line)
  } catch (err) {
    console.error('[pipe] malformed JSON:', line.slice(0, 120), err.message)
    return
  }

  if (!request.id) {
    console.warn('[pipe] message missing id:', request)
    return
  }

  const { id, method, params } = request
  const { path, body, query } = params || {}
  pipeLog('<<', `#${id} ${method?.toUpperCase()} ${path}`)

  try {
    const result = await handleRequest(method, path, body, query)
    pipeLog('>>', `#${id} OK`, result)
    pipeSend({ id, result })
  } catch (err) {
    pipeLog('>>', `#${id} ERR`, String(err))
    console.error(`[pipe] ${method} ${path} error:`, err)
    pipeSend({ id, error: String(err) })
  }
}

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
      pipeLog('>>', `push:${msg.type}`)
      pipeSend(msg)
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
    // Schedule teardown after the response has flushed through the pipe.
    // setTimeout(0) lets the caller's pipe.write() complete first.
    setTimeout(async () => {
      if (removePushListener) removePushListener()
      if (engineBridge) engineBridge.detach()
      if (engine) {
        await engine.stop()
        await engine.close()
      }
      if (store) await store.close()
      Pear.exit()
    }, 50)
    return { ok: true }
  }

  if (method === 'get' && path === '/api/pick-folder') {
    return pickFolder()
  }

  throw new Error(`Unknown route: ${method} ${path}`)
}

function pickFolder () {
  const platform = os.platform()
  let cmd, args
  if (platform === 'darwin') {
    cmd = 'osascript'
    args = ['-e', 'POSIX path of (choose folder with prompt "Select folder to sync")']
  } else if (platform === 'win32') {
    cmd = 'powershell'
    args = ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; ' +
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
      '$d.Description = "Select folder to sync"; ' +
      'if ($d.ShowDialog() -eq "OK") { $d.SelectedPath } else { exit 1 }'
    ]
  } else {
    // Linux — try zenity first, fall back to kdialog
    cmd = 'zenity'
    args = ['--file-selection', '--directory', '--title=Select folder to sync']
  }

  return new Promise((resolve, reject) => {
    const proc = spawnProcess(cmd, args)
    let stdout = ''
    proc.stdout.on('data', (data) => { stdout += Buffer.from(data).toString() })
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error('Folder selection cancelled'))
        return
      }
      let folder = stdout.trim()
      if (folder.endsWith('/') || folder.endsWith('\\')) folder = folder.slice(0, -1)
      resolve({ folder })
    })
  })
}

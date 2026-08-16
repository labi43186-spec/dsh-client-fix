/**
 * dsh-client-fix — 客户端修复插件 (v1.2.3)
 *
 * 功能：
 *   1. 向 desktop 对齐：desktop 有 web 没有→补装；desktop 没有 web 有→移除；
 *      两边都有但版本不同→web 对齐到 desktop 版本
 *   2. 安装前预加当前版本 minimumReleaseAge 豁免（幂等）
 *   3. 修复 DSH Desktop shim 编码问题（chcp 65001）
 *
 * 无自动同步、无轮询：只提供手动 HTTP 接口 + 启动修复 shim
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-client-fix'

const PROFILES = ['desktop', 'web']
const NPM_GLOBAL = join(homedir(), 'AppData', 'Roaming', 'npm')
const PROFILE_DIR = join(homedir(), '.dsh', 'profiles')
const SHIM_DIR = join(homedir(), 'AppData', 'Roaming', 'DSH Desktop', 'runtime-commands')
const SHIM_FILES = [
  join(SHIM_DIR, 'bin', 'pnpm.cmd'),
  join(SHIM_DIR, 'private', 'node-bin', 'node.cmd'),
]

/** 读取一个 profile 的依赖声明（排除官方 @deepseek-ai 包）。 */
function readDeps(profile) {
  try {
    const manifest = JSON.parse(readFileSync(join(PROFILE_DIR, profile, 'package.json'), 'utf8'))
    const deps = {}
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!name.startsWith('@deepseek-ai/')) deps[name] = spec
    }
    return deps
  } catch {
    return {}
  }
}

/** 版本号解析为数字数组用于比较。 */
function parseVersion(spec) {
  const s = String(spec ?? '').replace(/^[\^~]/, '')
  return s.split('.').map((n) => Number(n) || 0)
}

/** 比较两个版本声明，返回 -1 / 0 / 1。 */
function compareSpecs(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** 确保某包@版本在 profile 的 minimumReleaseAgeExclude 中（自动加豁免）。 */
function ensureReleaseAgeExclusion(profile, name, version) {
  const target = name + '@' + version
  const wsPath = join(PROFILE_DIR, profile, 'pnpm-workspace.yaml')
  try {
    if (!existsSync(wsPath)) return false
    let content = readFileSync(wsPath, 'utf8')
    if (content.includes("  - '" + target + "'")) return false
    const lines = content.split(/\r?\n/)
    let inserted = false
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === 'minimumReleaseAgeExclude:') {
        let j = i + 1
        while (j < lines.length && (lines[j].trim().startsWith('-') || lines[j].trim() === '')) j++
        lines.splice(j, 0, "  - '" + target + "'")
        inserted = true
        break
      }
    }
    if (!inserted) {
      lines.push('')
      lines.push('minimumReleaseAgeExclude:')
      lines.push("  - '" + target + "'")
    }
    writeFileSync(wsPath, lines.join('\n') + '\n', 'utf8')
    return true
  } catch { return false }
}

/** 用 dsh CLI 从指定 profile 移除插件。 */
function removeDsh(profile, name) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env, PATH: NPM_GLOBAL + ';' + (process.env.PATH ?? '') }
    const child = spawn('dsh', ['plugin', '--profile', profile, 'remove', name], {
      env,
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { } }, 120000)
    child.stderr?.on('data', (c) => { stderr = (stderr + c.toString()).slice(-1500) })
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ ok: false, stderr: String(err.message) }) })
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ ok: code === 0, code: code ?? -1, stderr }) })
  })
}

/** 用 dsh CLI 安装精确版本（Windows 下经 shell 解析 dsh.cmd，自动修正 PATH）。 */
function runDsh(profile, name, version) {
  return new Promise((resolvePromise) => {
    const target = name + '@' + version
    const env = { ...process.env, PATH: NPM_GLOBAL + ';' + (process.env.PATH ?? '') }
    const child = spawn('dsh', ['plugin', '--profile', profile, 'add', target], {
      env,
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 忽略 */ }
    }, 180000)
    child.stdout?.on('data', (c) => { stdout = (stdout + c.toString()).slice(-1500) })
    child.stderr?.on('data', (c) => { stderr = (stderr + c.toString()).slice(-1500) })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, code: 'SPAWN-ERROR', stderr: String(err.message).slice(-300) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, code: code ?? -1, stdout, stderr })
    })
  })
}

/** 计算需要执行的同步操作列表（向 desktop 对齐）。 */
function planSync(forceLatest = false) {
  const depsA = readDeps('desktop')
  const depsB = readDeps('web')
  const all = new Set([...Object.keys(depsA), ...Object.keys(depsB)])
  const ops = []
  for (const name of all) {
    const specA = depsA[name]
    const specB = depsB[name]
    // 向 desktop 对齐：
    //  - desktop 有、web 没有 → 补装到 web
    //  - desktop 没有、web 有 → 从 web 移除
    //  - 两边都有但版本不同 → 对齐到 desktop 版本
    if (specA === undefined && specB !== undefined) {
      ops.push({ name, version: null, action: 'remove-from-web' })
      continue
    }
    if (specA !== undefined && specB === undefined) {
      const version = specA.replace(/^[\^~]/, '')
      ops.push({ name, version, action: 'install-to-web' })
      continue
    }
    if (specA === undefined && specB === undefined) continue
    const cmp = compareSpecs(specA, specB)
    if (cmp !== 0) {
      const version = specA.replace(/^[\^~]/, '')
      ops.push({ name, version, action: 'align-to-desktop' })
    } else if (forceLatest) {
      ops.push({ name, version: null, action: 'check-latest' })
    }
  }
  return ops
}

/** 同步执行（安装前预加当前版本豁免；失败兜底重试一次）。 */
async function sync(forceLatest = false) {
  const ops = planSync(forceLatest)
  const executed = []
  for (const op of ops) {
    if (op.action === 'check-latest') {
      try {
        const res = await fetch('https://registry.npmjs.org/' + encodeURIComponent(op.name) + '/latest', {
          headers: { accept: 'application/json', 'user-agent': 'dsh-client-fix' },
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) continue
        const meta = await res.json()
        const latest = meta.version
        const current = readDeps('desktop')[op.name]?.replace(/^[\^~]/, '')
        if (latest && current !== latest) {
          executed.push({ name: op.name, version: latest, action: 'upgrade' })
        }
      } catch { /* registry 不可达则跳过 */ }
      continue
    }
    if (op.action === 'remove-from-web') {
      const out = await removeDsh('web', op.name)
      executed.push({ ...op, profile: 'web', ok: out.ok, code: out.code, stderr: out.stderr.slice(-200) })
      continue
    }
    if (op.action === 'install-to-web' || op.action === 'align-to-desktop') {
      // 预加豁免：执行前直接确保该包@版本在 minimumReleaseAgeExclude 中
      ensureReleaseAgeExclusion('web', op.name, op.version)
      let out = await runDsh('web', op.name, op.version)
      // 兜底：万一仍有拦截，再走失败后豁免重试一次
      if (!out.ok && /minimumReleaseAge|within the minimumReleaseAge cutoff|MINIMUM_RELEASE_AGE/i.test(out.stderr)) {
        out = await runDsh('web', op.name, op.version)
        if (out.ok) {
          executed.push({ ...op, profile: 'web', ok: true, code: 0, autoExcluded: true, stderr: '' })
          continue
        }
      }
      executed.push({ ...op, profile: 'web', ok: out.ok, code: out.code, stderr: out.stderr.slice(-200) })
      continue
    }
  }
  return executed
}

/** 修复 DSH Desktop 生成的 pnpm/node shim 编码问题。 */
function repairShims() {
  const fixed = []
  for (const file of SHIM_FILES) {
    try {
      if (!existsSync(file)) continue
      let content = readFileSync(file, 'utf8')
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
      const lines = content.split(/\r?\n/)
      if ((lines[0] ?? '').trim() !== '@echo off') continue
      if (lines.some((l) => l.includes('chcp 65001'))) continue
      lines.splice(1, 0, 'chcp 65001 >nul')
      writeFileSync(file, lines.join('\r\n'), 'utf8')
      fixed.push(file.split('\\').pop())
    } catch { /* 单文件失败不阻断 */ }
  }
  return fixed
}

/** 统一响应工具。 */
function send(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

/** 同源校验（与官方市场一致）。 */
function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try { return new URL(origin).host === host } catch { return false }
}

/** 路由分发。 */
function handler(request, response) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (url.pathname === '/dsh-client-fix/status') {
    const depsA = readDeps('desktop')
    const depsB = readDeps('web')
    const differences = []
    const all = new Set([...Object.keys(depsA), ...Object.keys(depsB)])
    for (const name of all) {
      const norm = (s) => String(s ?? '').replace(/^[\^~]/, '')
      const a = depsA[name], b = depsB[name]
      if (a === undefined || b === undefined) {
        differences.push({ name, desktop: a ?? '(缺)', web: b ?? '(缺)' })
        continue
      }
      if (norm(a) !== norm(b)) {
        differences.push({ name, desktop: a, web: b })
      }
    }
    send(response, 200, { ok: true, profiles: PROFILES, differences })
    return
  }
  if (url.pathname === '/dsh-client-fix/sync') {
    if (request.method !== 'POST') { send(response, 405, { ok: false, error: 'method not allowed' }); return }
    if (!sameOrigin(request)) { send(response, 403, { ok: false, error: 'untrusted origin' }); return }
    const force = url.searchParams.get('force') === '1'
    sync(force).then((executed) => {
      send(response, 200, { ok: true, executed })
    }).catch((error) => {
      send(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    })
    return
  }
  if (url.pathname === '/dsh-client-fix/repair-shims') {
    if (request.method !== 'POST') { send(response, 405, { ok: false, error: 'method not allowed' }); return }
    if (!sameOrigin(request)) { send(response, 403, { ok: false, error: 'untrusted origin' }); return }
    const fixed = repairShims()
    send(response, 200, { ok: true, fixed })
    return
  }
  send(response, 404, { ok: false, error: 'not found' })
}


/**
 * 无延迟自动同步：fs.watch 监听 desktop 的 package.json 与 pnpm-lock.yaml。
 * 市场更新（走 dsh plugin add -> pnpm）必然改动这两个文件之一，
 * 事件触发后防抖 800ms（合并原子写/多次事件），读取差异并同步 web。
 * desktop 是基准且插件只改 web，故不会自我触发循环。
 */
function watchDesktopSync() {
  const targets = [
    join(PROFILE_DIR, 'desktop', 'package.json'),
    join(PROFILE_DIR, 'desktop', 'pnpm-lock.yaml'),
  ]
  let debounce = null
  const watchers = []
  const onEvent = () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      try {
        const ops = planSync(false)
        if (ops.length === 0) return
        console.log('[dsh-client-fix] 检测到 desktop 插件变化，同步 web…')
        sync(false).then((executed) => {
          console.log('[dsh-client-fix] 自动同步完成: ' + JSON.stringify(executed.map((e) => e.name + ' -> ' + e.profile)))
        }).catch(() => { /* 静默 */ })
      } catch { /* 单次失败不阻断 */ }
    }, 800)
  }
  for (const target of targets) {
    try {
      watchers.push(watch(target, { persistent: false }, onEvent))
    } catch { /* 文件暂不存在则跳过 */ }
  }
  return () => {
    if (debounce) clearTimeout(debounce)
    for (const w of watchers) { try { w.close() } catch { } }
  }
}

export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    const register = (path, h) => host.webServer.register({ kind: 'exact', path, handler: h })
    host.effect(() => {
      const disposers = [
        register('/dsh-client-fix/status', (req, res) => handler(req, res)),
        register('/dsh-client-fix/sync', (req, res) => handler(req, res)),
        register('/dsh-client-fix/repair-shims', (req, res) => handler(req, res)),
      ]
      // 启动后延迟修复 shim（仅此一次）
      const timer = setTimeout(() => {
        try {
          const fixed = repairShims()
          if (fixed.length > 0) console.log('[dsh-client-fix] 已修复 shim: ' + fixed.join(', '))
        } catch { /* 静默 */ }
      }, 3000)
      // 无延迟自动同步：fs.watch 监听 desktop 变化，市场一更新就同步 web
      const disposeWatch = watchDesktopSync()
      return () => {
        for (const d of disposers) d()
        clearTimeout(timer)
        disposeWatch()
      }
    }, 'dsh-client-fix: http routes')
  })
}

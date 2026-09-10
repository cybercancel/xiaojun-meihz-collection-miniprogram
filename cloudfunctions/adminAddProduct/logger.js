'use strict'
// 共享结构化日志 + 请求上下文（单一来源，TASK-210 建立；TASK-270 扩展 requestId）。
// 设计目标：
//   1. 自动剔除敏感字段，避免密钥 / 令牌 / openid 等泄露到日志。
//   2. 统一管理 requestId：每次调用链路一个稳定 requestId，贯穿日志 / 错误 / 审计。
//   3. 并发安全：基于 AsyncLocalStorage，同一容器并发处理多请求时各请求上下文互不串扰。
// 用法：
//   const { wrap, info, warn, error, getRequestId } = require('./logger')
//   exports.main = wrap('myFn', async (event, context) => { ... })

const crypto = require('crypto')
const { AsyncLocalStorage } = require('async_hooks')

// TASK-280：防御性 require 监控模块（未同步到本函数目录时降级，监控不可用但不影响主流程）
let _metrics = null
try { _metrics = require('./metrics') } catch (e) { /* metrics 未同步则降级 */ }

const SENSITIVE_KEYS = [
  'token', 'password', 'passwd', 'pwd', 'secret', 'apikey', 'api_key',
  'cert', 'key', 'openid', 'session', 'authorization', 'cookie', 'privatekey'
]
const REDACTED = '***'

// 单次调用链路的请求上下文存储（并发安全）
const _als = new AsyncLocalStorage()

function redact(value, seen) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return value
  seen = seen || new Set()
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(v => redact(v, seen))
  const out = {}
  for (const k of Object.keys(value)) {
    const lk = String(k).toLowerCase()
    if (SENSITIVE_KEYS.some(s => lk.includes(s))) out[k] = REDACTED
    else out[k] = redact(value[k], seen)
  }
  return out
}

function genRequestId() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch (e) { /* ignore */ }
  return 'req_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex')
}

// 进入一个调用上下文；若已有上下文且调用方未显式传入 requestId，则沿用（支持嵌套/透传）。
// 返回最终生效的 requestId。
function enter(fnName, event) {
  const incoming = event && (event.__requestId || event.requestId)
  const parent = _als.getStore()
  const rid = (parent && parent.requestId && !incoming)
    ? parent.requestId
    : (incoming || genRequestId())
  _als.enterWith({ requestId: rid, fn: fnName, start: Date.now() })
  return rid
}

function getRequestId() {
  const s = _als.getStore()
  return s ? s.requestId : ''
}

function getContext() {
  return _als.getStore() || {}
}

function fmt(level, msg, meta) {
  const store = _als.getStore()
  const base = {
    t: new Date().toISOString(),
    level,
    fn: store && store.fn,
    requestId: store ? store.requestId : ''
  }
  if (msg !== undefined) base.msg = msg
  if (meta !== undefined) base.meta = redact(meta)
  try {
    return JSON.stringify(base)
  } catch (e) {
    return JSON.stringify({ t: base.t, level, fn: base.fn, requestId: base.requestId, msg: String(msg) })
  }
}

function log(level, msg, meta) { console.log(fmt(level, msg, meta)) }
function info(msg, meta) { log('INFO', msg, meta) }
function warn(msg, meta) { log('WARN', msg, meta) }
function error(msg, meta) { console.error(fmt('ERROR', msg, meta)) }

// 统一云函数入口包装：注入 requestId、结构化记录、结果回挂 requestId、异常落日志。
// 使用 _als.run 将上下文严格限定在 handler 执行期内，结束后自动清除，避免跨请求串扰。
// handler 失败时会记录错误并原样抛出（由上层 safeError / webhook 契约自行决定响应结构）。
// TASK-280：自动记录耗时样本（latency）与错误事件（func_error），用于异常监控指标。
function wrap(name, handler) {
  return async function (event, context) {
    const incoming = event && (event.__requestId || event.requestId)
    const parent = _als.getStore()
    const rid = (parent && parent.requestId && !incoming)
      ? parent.requestId
      : (incoming || genRequestId())
    const store = { requestId: rid, fn: name, start: Date.now() }
    return _als.run(store, async () => {
      const start = store.start
      try {
        const res = await handler(event, context)
        if (res && typeof res === 'object' && !('requestId' in res)) {
          try { res.requestId = rid } catch (_) { /* 冻结对象忽略 */ }
        }
        // 业务错误以 {success:false} 正常返回时，同样计入错误率（不依赖抛异常）
        const isErr = !!(res && typeof res === 'object' && res.success === false)
        const errCode = isErr
          ? ((res.error && res.error.code) || res.code || undefined)
          : undefined
        await recordMetrics(name, start, isErr, errCode, isErr ? res : null)
        return res
      } catch (e) {
        error('handler_failed', {
          code: e && e.code,
          error: e && e.message,
          stack: (e && e.stack) ? String(e.stack).split('\n').slice(0, 3).join(' | ') : undefined
        })
        await recordMetrics(name, start, true, e && e.code, e)
        throw e
      }
    })
  }
}

// TASK-280：数据库异常识别。CloudBase 数据库错误常见形态：
//   - errCode 为 -50xxxx 的数字码（如 -502005 集合不存在）
//   - code / errCode 形如 'DATABASE_xxx'、'DATABASE_REQUEST_FAILED'
//   - message 含 collection / database / transaction 等关键词
const DB_ERR_RE = /(database|collection|document|transaction|数据库|集合)/i
function isDbError(err, code) {
  try {
    const c = String((err && (err.errCode !== undefined ? err.errCode : err.code)) || code || '')
    if (/^-5\d{5}$/.test(c)) return true
    if (/^DATABASE/i.test(c)) return true
    const msg = (err && err.message) || ''
    return DB_ERR_RE.test(msg)
  } catch (e) {
    return false
  }
}

// TASK-280：best-effort 记录云函数耗时与错误（绝不阻断主流程）。
// 每次调用记一条 latency 样本（value=毫秒，既是 P95 数据源，也是错误率/DB 失败率的分母）；
// 错误时再记一条 func_error（dims.code 便于分维度），若判定为数据库异常则额外记 db_error。
async function recordMetrics(name, start, isError, code, errObj) {
  if (!_metrics) return
  try {
    await _metrics.track('latency', { fn: name, value: Date.now() - start })
    if (isError) {
      await _metrics.track('func_error', { fn: name, dims: { code: code || 'UNKNOWN' } })
      if (isDbError(errObj, code)) {
        await _metrics.track('db_error', { fn: name, dims: { code: code || 'UNKNOWN' } })
      }
    }
  } catch (e) { /* best-effort 监控，失败忽略 */ }
}

module.exports = {
  info, warn, error, log,
  redact,
  genRequestId,
  getRequestId,
  getContext,
  enter,
  wrap
}

'use strict'
// 共享监控指标模块（单一来源，TASK-280）
// 设计：每一次指标事件追加一条 doc 到 metric_events 集合（时间序列 / 计数），
//       告警事件写入 metric_alerts 集合。全部 best-effort，失败仅 console.error，绝不阻断主流程。
//
// 用法：
//   const { track, inc, alert } = require('./metrics')
//   await inc('order.create.success', { fn: 'createOrder' })
//   await track('latency', { fn: 'wxpay', value: 123 })          // value 传毫秒
//   await alert('PAY_AMOUNT_MISMATCH', { orderNo, expect, actual }, 'high')
//
// 约定：
//   - 本模块直接依赖 wx-server-sdk（云函数运行时已具备），不依赖 database.js，
//     以便可同步到任意云函数目录（含未同步 database.js 的函数）。
//   - requestId 采用惰性 require logger（规避循环依赖导致初始化期拿不到的问题）。
//   - 集合结构（由 initDatabase 负责建表，见 initDatabase.js）：
//       metric_events : { key, fn, date, ts, value, requestId, dims? }
//       metric_alerts: { type, severity, detail, ts, resolved, requestId }

const cloud = require('wx-server-sdk')

let _db = null
function getDb() {
  if (!_db) _db = cloud.database()
  return _db
}

// 惰性获取当前 requestId，避免与 logger 形成循环依赖导致初始化期拿不到
function currentRequestId() {
  try {
    const g = require('./logger').getRequestId
    return g ? g() : ''
  } catch (e) {
    return ''
  }
}

// 'YYYY-MM-DD'（与看板读取使用同一函数，保证日期分桶一致）
function todayStr(d) {
  const x = d || new Date()
  const y = x.getFullYear()
  const m = String(x.getMonth() + 1).padStart(2, '0')
  const day = String(x.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}

// 记录一条指标事件。value 默认 1（计数）；耗时类传毫秒。
// opts: { fn, value, dims, date }
async function track(key, opts) {
  opts = opts || {}
  try {
    const db = getDb()
    const doc = {
      key: String(key),
      fn: opts.fn || '',
      date: todayStr(opts.date),
      ts: Date.now(),
      value: (typeof opts.value === 'number') ? opts.value : 1,
      requestId: currentRequestId()
    }
    if (opts.dims && typeof opts.dims === 'object') doc.dims = opts.dims
    await db.collection('metric_events').add({ data: doc })
  } catch (e) {
    console.error('[metrics.track]', e && e.message)
  }
}

// 计数便捷方法：每次 +1（或 +value）
async function inc(key, opts) {
  opts = opts || {}
  const o = Object.assign({}, opts)
  if (typeof o.value !== 'number') o.value = 1
  return track(key, o)
}

// 记录一条告警。detail 为对象，severity 默认 'high'。
async function alert(type, detail, severity) {
  try {
    const db = getDb()
    const doc = {
      type: String(type),
      severity: severity || 'high',
      detail: detail || {},
      ts: Date.now(),
      resolved: false,
      requestId: currentRequestId()
    }
    await db.collection('metric_alerts').add({ data: doc })
  } catch (e) {
    console.error('[metrics.alert]', e && e.message)
  }
}

module.exports = { track, inc, alert, todayStr, getDb }

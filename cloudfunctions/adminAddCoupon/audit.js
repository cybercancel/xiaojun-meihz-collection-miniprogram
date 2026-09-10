'use strict'
// 共享管理员操作审计模块（单一来源，TASK-240）。
// 记录敏感管理操作到 admin_audit_logs，并对敏感字段脱敏。
// 由 scripts/sync-cloudfunction-shared.js 同步到各 admin 云函数，禁止在各云函数内联副本。
//
// 设计原则：
//  - Best-effort：审计写入失败不得阻断主业务流程（审计是安全网，不是业务闸门）。
//  - 敏感字段强制脱敏：手机号/地址/Token/密码/支付证书/密钥等。
//  - 自包含：仅依赖 wx-server-sdk（调用方传入 db），不引入额外共享依赖，避免同步耦合。

const crypto = require('crypto')

// TASK-270：优先复用 logger 的全局 requestId（并发安全），降级用本模块本地生成。
let _getReqId = null
try { _getReqId = require('./logger').getRequestId } catch (e) { /* logger 未同步则降级 */ }

const COLLECTION = 'admin_audit_logs'

// 操作类型常量（与任务书“重点审计”清单一一对应）
const ACTIONS = {
  ADMIN_LOGIN: 'ADMIN_LOGIN',
  ADMIN_LOGIN_FAIL: 'ADMIN_LOGIN_FAIL',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PRODUCT_ADD: 'PRODUCT_ADD',
  PRODUCT_UPDATE: 'PRODUCT_UPDATE',
  PRODUCT_DELETE: 'PRODUCT_DELETE',
  ORDER_STATUS_CHANGE: 'ORDER_STATUS_CHANGE',
  ORDER_SHIP: 'ORDER_SHIP',
  ORDER_PICKUP_CONFIRM: 'ORDER_PICKUP_CONFIRM',
  REFUND_APPROVE: 'REFUND_APPROVE',
  COUPON_ISSUE: 'COUPON_ISSUE',
  COUPON_TEMPLATE_ADD: 'COUPON_TEMPLATE_ADD',
  USER_LEVEL_UPDATE: 'USER_LEVEL_UPDATE',
  SHOP_SETTINGS_UPDATE: 'SHOP_SETTINGS_UPDATE',
  DB_INIT: 'DB_INIT',
  ADMIN_ACCESS_PRIVATE: 'ADMIN_ACCESS_PRIVATE'
}

// 需脱敏的字段名（不区分大小写，子串匹配）
const SENSITIVE_KEYS = [
  'phone', 'mobile', 'tel', 'telephone', 'cellphone',
  'address', 'addr',
  'token', 'tok', 'accesstoken', 'refreshtoken',
  'password', 'passwd', 'pwd', 'credential',
  'cert', 'certificate', 'certpem', 'privatekey', 'private_key',
  'secret', 'apikey', 'api_key', 'appsecret', 'signkey', 'signkey',
  'session', 'cookie', 'authorization', 'auth',
  'openid',
  'idcard', 'id_card', 'idnumber', 'idno', 'cardno', 'bankcard'
]

// 强脱敏字段：无论长度一律整体掩码，绝不泄露任何片段（密码/Token/证书/密钥/会话等）
const STRICT_MASK_KEYS = [
  'password', 'passwd', 'pwd', 'credential',
  'cert', 'certificate', 'certpem', 'privatekey', 'private_key',
  'secret', 'apikey', 'api_key', 'appsecret', 'signkey',
  'token', 'tok', 'accesstoken', 'refreshtoken',
  'session', 'cookie', 'authorization', 'auth', 'openid'
]

function isSensitiveKey(key) {
  const lk = String(key).toLowerCase()
  return SENSITIVE_KEYS.some(s => lk === s || lk.indexOf(s) !== -1)
}

function isStrictMaskKey(key) {
  const lk = String(key).toLowerCase()
  return STRICT_MASK_KEYS.some(s => lk === s || lk.indexOf(s) !== -1)
}

function maskScalar(key, value) {
  const lk = String(key).toLowerCase()
  const str = (value === null || value === undefined) ? '' : String(value)
  // 强脱敏：密码 / Token / 证书 / 密钥 / 会话凭证等一律整体掩码
  if (isStrictMaskKey(lk)) return '***'
  // 手机号：保留前 3 后 4，中间 ****
  if (/^1\d{10}$/.test(str)) return str.slice(0, 3) + '****' + str.slice(-4)
  // 地址：保留前 6 字符 + 掩码（避免泄露完整收件信息）
  if (lk.indexOf('address') !== -1 || lk.indexOf('addr') !== -1) {
    return str.length > 6 ? str.slice(0, 6) + '***' : '***'
  }
  // 其余敏感字段：长度 > 6 保留首尾 2 位，否则整体掩码
  if (str.length > 6) return str.slice(0, 2) + '***' + str.slice(-2)
  return '***'
}

/**
 * 递归脱敏对象中的敏感字段（含数组）。
 * @param {*} obj
 * @param {number} [depth=0]
 * @param {Set} [seen]
 */
function maskSensitive(obj, depth, seen) {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj
  if (depth > 6) return '[OMITTED]'
  seen = seen || new Set()
  if (seen.has(obj)) return '[Circular]'
  seen.add(obj)
  if (Array.isArray(obj)) return obj.map(v => maskSensitive(v, depth + 1, seen))
  const out = {}
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (isSensitiveKey(k)) {
      out[k] = maskScalar(k, v)
    } else if (typeof v === 'object' && v !== null) {
      out[k] = maskSensitive(v, depth + 1, seen)
    } else {
      out[k] = v
    }
  }
  return out
}

function genRequestId() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch (e) { /* ignore */ }
  return 'audit-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex')
}

/**
 * 落库一条审计记录（best-effort）。
 * @param {Object} db - cloud.database() 实例
 * @param {Object} entry
 *   - requestId?: string
 *   - adminId?: string
 *   - adminRole?: string
 *   - action: string (ACTIONS.*)
 *   - targetType?: string
 *   - targetId?: string
 *   - before?: object
 *   - after?: object
 *   - result?: 'SUCCESS' | 'FAIL'
 *   - errorCode?: string
 * @returns {Promise<void>}
 */
async function logAudit(db, entry) {
  try {
    const e = entry || {}
    const now = Date.now()
    const doc = {
      requestId: e.requestId || (_getReqId ? _getReqId() : '') || genRequestId(),
      adminId: e.adminId || '',
      adminRole: e.adminRole || '',
      action: e.action || 'UNKNOWN',
      targetType: e.targetType || '',
      targetId: e.targetId || '',
      detail: e.detail || null,
      before: maskSensitive(e.before, 0),
      after: maskSensitive(e.after, 0),
      result: e.result || 'SUCCESS',
      errorCode: e.errorCode || '',
      createdAt: now,
      _createTime: db.serverDate()
    }
    if (!db || typeof db.collection !== 'function') return
    await db.collection(COLLECTION).add({ data: doc })
  } catch (err) {
    // 审计失败不得影响主业务；仅记录到运行日志
    try {
      console.error('[audit] 审计日志写入失败 action=' + (entry && entry.action) + ' :', err && err.message ? err.message : err)
    } catch (_) { /* noop */ }
  }
}

/**
 * 从事件中取出审计所需的 admin 上下文（由 verifyAdmin 注入 event.__admin）。
 * 兼容未注入场景（如登录函数自行写入）。
 */
function adminCtx(event) {
  const a = (event && event.__admin) || {}
  return { adminId: a.adminId || '', adminRole: a.role || '' }
}

module.exports = { ACTIONS, logAudit, maskSensitive, adminCtx, COLLECTION }

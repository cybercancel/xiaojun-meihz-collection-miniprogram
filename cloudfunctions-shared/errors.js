// 统一错误与响应结构（TASK-200）
// 所有用户侧 RPC 云函数统一返回：
//   { success: false, error: { code, message, requestId } }
//   { success: true,  data: ... }
// 严禁将数据库异常、堆栈、内部字段直接返回前端。
//
// 注：微信支付回调 wxpayNotify / 退款回调 wxRefundNotify 是 HTTP webhook，
// 必须返回微信约定的 { return_code, return_msg } 结构，不适用本模块的统一 JSON-RPC 结构。

'use strict'

// TASK-270：优先复用 logger 的全局 requestId（并发安全的 AsyncLocalStorage），
// 降级时退回本模块本地生成的 id。防御性 require，避免 logger 未同步到本函数目录时报错。
let _getReqId = null
try { _getReqId = require('./logger').getRequestId } catch (e) { /* logger 未同步则降级 */ }

// 业务错误：携带可对外暴露的 code + message
class AppError extends Error {
  constructor(code, message, httpStatus) {
    super(message || '')
    this.name = 'AppError'
    this.code = code
    this.isAppError = true
    if (httpStatus) this.httpStatus = httpStatus
  }
}

// 生成短请求ID，便于在日志与前端间串联排查
function genRequestId() {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 10)
  return 'req_' + t + r
}

// 统一错误响应
function errorResponse(code, message, requestId) {
  return {
    success: false,
    error: {
      code: code || 'UNKNOWN_ERROR',
      message: message || '请求失败',
      requestId: requestId || ''
    }
  }
}

// 统一成功响应
function successResponse(data, extra) {
  const res = { success: true, data: data === undefined ? null : data }
  if (extra && typeof extra === 'object') {
    for (const k in extra) {
      if (k !== 'success' && k !== 'data') res[k] = extra[k]
    }
  }
  return res
}

// 命中以下特征的内部信息，视为不应外泄给前端（避免泄露 DB/堆栈/密钥细节）
const INTERNAL_MSG_RE = /(E\d{4}\b|duplicate key|MongoError|Cast to|ValidationError|TypeError|ReferenceError|Cannot read|is not a function|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|certificate|secret key|private key|is not defined|Maximum call stack)/i

// 把任意异常安全转换为统一错误响应，绝不外泄内部细节
function safeError(error, requestId) {
  // TASK-270：优先使用调用方传入 / 全局上下文的 requestId，最后才本地生成，保证链路一致
  const rid = requestId || (_getReqId ? _getReqId() : '') || genRequestId()
  if (error instanceof AppError) {
    return errorResponse(error.code, error.message, rid)
  }
  // 业务错误（已带 code 的普通 Error，如 couponError）
  if (error && error.code) {
    return errorResponse(error.code, error.message || '请求失败', rid)
  }
  // 普通业务异常：若语义明确且非内部信息，则透传文案，但统一 code 为 BUSINESS_ERROR
  const msg = (error && error.message) ? String(error.message) : ''
  if (msg && !INTERNAL_MSG_RE.test(msg)) {
    return errorResponse('BUSINESS_ERROR', msg.slice(0, 200), rid)
  }
  // 未预期异常：仅服务端记录完整信息
  console.error('[safeError] 未处理异常 requestId=' + rid + ':', error)
  return errorResponse('INTERNAL_ERROR', '服务器开小差了，请稍后重试', rid)
}

module.exports = {
  AppError,
  genRequestId,
  errorResponse,
  successResponse,
  safeError
}

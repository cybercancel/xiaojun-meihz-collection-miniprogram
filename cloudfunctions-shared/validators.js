// 统一输入校验（TASK-200）
// 所有校验器在失败时抛出 AppError(code='INVALID_PARAM' 或更高语义码, message)，
// 由调用方统一经 safeError 收敛为 { success:false, error:{code,message,requestId} }。
// 目标：禁止各云函数随意读取 event，统一校验类型、长度、枚举、必填字段。

'use strict'

const { AppError } = require('./errors')

function pick(obj, key) {
  return obj ? obj[key] : undefined
}

// 校验字符串：类型 / 必填 / 长度 / 正则
function validateString(value, opts) {
  opts = opts || {}
  const field = opts.field || '字段'
  const required = opts.required !== false // 默认必填
  if (value === undefined || value === null || value === '') {
    if (required) throw new AppError('INVALID_PARAM', field + '不能为空')
    return opts.default !== undefined ? opts.default : ''
  }
  if (typeof value !== 'string') {
    throw new AppError('INVALID_PARAM', field + '类型错误')
  }
  let v = opts.trim ? value.trim() : value
  if (opts.min != null && v.length < opts.min) {
    throw new AppError('INVALID_PARAM', field + '长度不能少于' + opts.min + '个字符')
  }
  if (opts.max != null && v.length > opts.max) {
    throw new AppError('INVALID_PARAM', field + '长度不能超过' + opts.max + '个字符')
  }
  if (opts.pattern && !opts.pattern.test(v)) {
    throw new AppError('INVALID_PARAM', field + '格式不正确')
  }
  return v
}

// 校验整数
function validateInteger(value, opts) {
  opts = opts || {}
  const field = opts.field || '数值'
  if (value === undefined || value === null || value === '') {
    if (opts.required === false) return opts.default !== undefined ? opts.default : 0
    throw new AppError('INVALID_PARAM', field + '不能为空')
  }
  const n = Number(value)
  if (!Number.isInteger(n)) {
    throw new AppError('INVALID_PARAM', field + '必须是整数')
  }
  if (opts.min != null && n < opts.min) {
    throw new AppError('INVALID_PARAM', field + '不能小于' + opts.min)
  }
  if (opts.max != null && n > opts.max) {
    throw new AppError('INVALID_PARAM', field + '不能大于' + opts.max)
  }
  return n
}

// 校验金额（分）：非负整数，可选上限
function validateMoneyFen(value, opts) {
  opts = opts || {}
  const field = opts.field || '金额'
  if (value === undefined || value === null || value === '') {
    if (opts.required === false) return opts.default !== undefined ? opts.default : 0
    throw new AppError('INVALID_PARAM', field + '不能为空')
  }
  const n = Number(value)
  if (!Number.isInteger(n)) {
    throw new AppError('INVALID_PARAM', field + '格式错误')
  }
  if (n < (opts.min != null ? opts.min : 0)) {
    throw new AppError('INVALID_PARAM', field + '不能为负数')
  }
  if (opts.max != null && n > opts.max) {
    throw new AppError('INVALID_PARAM', field + '超出上限')
  }
  return n
}

// 校验枚举
function validateEnum(value, opts) {
  opts = opts || {}
  const field = opts.field || '值'
  const allowed = opts.allowed || []
  if (value === undefined || value === null || value === '') {
    if (opts.required === false) return opts.default
    throw new AppError('INVALID_PARAM', field + '不能为空')
  }
  if (allowed.indexOf(value) === -1) {
    throw new AppError('INVALID_PARAM', field + '取值非法')
  }
  return value
}

// 校验 ObjectId：云开发 _id 通常为 24 位十六进制；兼容业务自定义字符串，禁止路径/注入字符
function validateObjectId(value, opts) {
  opts = opts || {}
  const field = opts.field || 'ID'
  if (value === undefined || value === null || value === '') {
    if (opts.required === false) return opts.default !== undefined ? opts.default : ''
    throw new AppError('INVALID_PARAM', field + '不能为空')
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new AppError('INVALID_PARAM', field + '格式错误')
  }
  if (/[\/\\.\s]/.test(value) || value.indexOf('$') !== -1) {
    throw new AppError('INVALID_PARAM', field + '格式错误')
  }
  return value
}

// 校验手机号（中国大陆）
function validatePhone(value, opts) {
  opts = opts || {}
  const field = opts.field || '手机号'
  if (value === undefined || value === null || value === '') {
    if (opts.required === false) return opts.default !== undefined ? opts.default : ''
    throw new AppError('INVALID_PARAM', field + '不能为空')
  }
  if (!/^1[3-9]\d{9}$/.test(String(value))) {
    throw new AppError('INVALID_PARAM', field + '格式不正确')
  }
  return String(value)
}

// 校验分页：返回 { page, pageSize, skip, limit }
function validatePagination(params, opts) {
  opts = opts || {}
  const maxPageSize = opts.maxPageSize || 50
  const defaultPageSize = opts.defaultPageSize || 20
  const page = validateInteger(pick(params, 'page'), { field: '页码', required: false, min: 1, default: 1 })
  const pageSize = validateInteger(pick(params, 'pageSize'), {
    field: '每页数量', required: false, min: 1, max: maxPageSize, default: defaultPageSize
  })
  return { page: page, pageSize: pageSize, skip: (page - 1) * pageSize, limit: pageSize }
}

// 校验订单项列表：合并同 productId、限制种类与单品数量，返回 [{productId, quantity}]
function validateItems(items, opts) {
  opts = opts || {}
  const maxCount = opts.maxCount || 50
  const maxQtyPerItem = opts.maxQtyPerItem || 99
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError('INVALID_PARAM', '商品列表不能为空')
  }
  if (items.length > maxCount) {
    throw new AppError('INVALID_PARAM', '单次下单商品种类不能超过' + maxCount)
  }
  const normalized = []
  const qtyMap = {}
  for (let i = 0; i < items.length; i++) {
    const raw = items[i]
    const productId = validateObjectId(pick(raw, 'productId'), { field: '第' + (i + 1) + '个商品ID' })
    const quantity = validateInteger(pick(raw, 'quantity'), { field: '第' + (i + 1) + '个商品数量', min: 1, max: maxQtyPerItem })
    const merged = (qtyMap[productId] || 0) + quantity
    if (merged > maxQtyPerItem) {
      throw new AppError('INVALID_PARAM', '商品' + productId + '购买数量不能超过' + maxQtyPerItem)
    }
    qtyMap[productId] = merged
  }
  for (const pid in qtyMap) {
    normalized.push({ productId: pid, quantity: qtyMap[pid] })
  }
  return normalized
}

// 校验配送方式
function validateDeliveryType(value, opts) {
  return validateEnum(value, Object.assign({ field: '配送方式', allowed: ['delivery', 'pickup'] }, opts || {}))
}

// 校验订单状态枚举（0待付款 1待发货 2配送中 3已完成 4已取消 5退款申请中 6退款处理中 7已退款）
function validateOrderStatus(value, opts) {
  opts = opts || {}
  const allowed = opts.allowed || [0, 1, 2, 3, 4, 5, 6, 7]
  if (value === undefined || value === null || value === '') {
    if (opts.required === false) return opts.default
    throw new AppError('INVALID_PARAM', '订单状态不能为空')
  }
  const n = Number(value)
  if (!Number.isInteger(n) || allowed.indexOf(n) === -1) {
    throw new AppError('INVALID_PARAM', '订单状态非法')
  }
  return n
}

// 文本净化：去除控制字符、限制长度、可选 HTML 转义（防 XSS / 存储型注入）
function sanitizeText(text, opts) {
  opts = opts || {}
  if (text === undefined || text === null) return ''
  let s = String(text)
  // 去除不可见控制字符（保留换行 \n 与制表 \t）
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  if (opts.max != null && s.length > opts.max) {
    s = s.slice(0, opts.max)
  }
  if (opts.escapeHtml) {
    s = s.replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }
  return s
}

// 【TASK-110/170/500】从订单对象安全取实付金额（分）：优先整数分字段，兜底旧元字段换算。
function resolvePaidAmountFen(order) {
  if (!order || typeof order !== 'object') return 0
  if (Number.isInteger(order.totalFen)) return order.totalFen
  return Math.round(Number(order.totalPrice || order.totalAmount || 0) * 100)
}

// 【TASK-170/500】退款金额校验：退款金额不得超过实付金额（行为保持与 adminProcessRefund 一致）。
// 返回 { valid:boolean, code?:string, message?:string }
function validateRefundAmount(refundAmountFen, paidAmountFen) {
  const refund = Number(refundAmountFen)
  const paid = Number(paidAmountFen)
  if (!paid || paid <= 0) {
    return { valid: false, code: 'INVALID_PAID_AMOUNT', message: '订单实付金额无效' }
  }
  if (!Number.isFinite(refund) || refund <= 0) {
    return { valid: false, code: 'INVALID_REFUND_AMOUNT', message: '退款金额无效' }
  }
  if (refund > paid) {
    return { valid: false, code: 'REFUND_AMOUNT_EXCEEDED', message: '退款金额超过实付金额' }
  }
  return { valid: true }
}

module.exports = {
  validateString,
  validateInteger,
  validateMoneyFen,
  validateEnum,
  validateObjectId,
  validatePhone,
  validatePagination,
  validateItems,
  validateDeliveryType,
  validateOrderStatus,
  sanitizeText,
  resolvePaidAmountFen,
  validateRefundAmount
}

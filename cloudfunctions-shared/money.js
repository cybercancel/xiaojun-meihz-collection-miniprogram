'use strict'
// 金额与支付环境助手（单一来源，TASK-210）。
// 金额一律以「分」为整数单位处理，避免浮点误差。
// 与前端 utils/money.js 保持契约一致：toFen / fenToYuan / fenToYuanText / subYuan / mulYuan。
// 由 scripts/sync-cloudfunction-shared.js 同步到各云函数。

// 元 → 分（四舍五入为整数）
function toFen(yuan) {
  const n = Number(yuan)
  if (!isFinite(n)) return 0
  return Math.round(n * 100)
}

// 分 → 元（数值）
function fenToYuan(fen) {
  const n = Number(fen)
  if (!isFinite(n)) return 0
  return n / 100
}

// 分 → 元（字符串，保留两位小数）
function fenToYuanText(fen) {
  return fenToYuan(fen).toFixed(2)
}

// 元减（a - b），以分计算避免浮点误差
function subYuan(aYuan, bYuan) {
  return fenToYuan(toFen(aYuan) - toFen(bYuan))
}

// 元乘系数（b 可为小数，如折扣），以分计算避免浮点误差
function mulYuan(aYuan, b) {
  return fenToYuan(toFen(aYuan) * Math.round(Number(b) * 100) / 100)
}

// 从订单对象安全取实付金额（分）：优先整数分字段，兜底旧元字段
function safeTotalFen(order) {
  if (order && Number.isInteger(order.totalFen)) return order.totalFen
  const v = (order && (order.totalPrice || order.totalAmount)) || 0
  return Math.round(Number(v) * 100)
}

// 【TASK-100】服务端支付环境判定：
//   生产环境（APP_ENV=production）永远拒绝模拟支付；
//   模拟仅允许「非生产环境 + 显式开启 ENABLE_MOCK_PAYMENT / WXPAY_ENABLE_MOCK」。
// 客户端传入的任何 mock 标志一律忽略（由调用方在入口处剔除）。
function resolvePaymentEnv() {
  const environment = (process.env.APP_ENV || 'production').toLowerCase()
  const isProduction = environment === 'production'
  const mockEnvOn =
    process.env.ENABLE_MOCK_PAYMENT === 'true' ||
    process.env.WXPAY_ENABLE_MOCK === 'true'
  const mockAllowed = !isProduction && mockEnvOn
  return { environment, isProduction, mockAllowed }
}

module.exports = {
  toFen,
  fenToYuan,
  fenToYuanText,
  subYuan,
  mulYuan,
  safeTotalFen,
  resolvePaymentEnv
}

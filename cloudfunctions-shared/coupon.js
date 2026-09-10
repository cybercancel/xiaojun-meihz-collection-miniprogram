'use strict'
// 优惠券纯计算（单一来源，TASK-500）。
// 仅做金额/门槛计算，不依赖 wx-server-sdk，也不做 DB 归属/状态/过期校验
// （那些属于 createOrder 事务内的强校验，见 createOrder/index.js）。
// 因 createOrder 当前未同步 money.js，此处内联 toFen 以保持零依赖、可独立同步与单测。

// 元 → 分（与 cloudfunctions-shared/money.js.toFen 契约一致：四舍五入、非有限值→0）
function toFen(yuan) {
  const n = Number(yuan)
  if (!isFinite(n)) return 0
  return Math.round(n * 100)
}

// 最低消费门槛（分域：优先整数分字段 minAmountFen，兜底旧元字段 minAmount）
function couponMinAmountFen(coupon) {
  if (!coupon) return 0
  return Number.isInteger(coupon.minAmountFen) ? coupon.minAmountFen : toFen(coupon.minAmount || 0)
}

// 是否达到使用门槛（不含 DB 归属/状态/过期校验）
function isCouponUsable(goodsTotalFen, coupon) {
  if (!coupon) return false
  return Number(goodsTotalFen) >= couponMinAmountFen(coupon)
}

// 计算优惠金额（分）：
//   cash   → 满减（封顶商品总额）
//   discount → 打折（(1 - 折扣/10) * 总额，四舍五入）
// 最终夹在 [0, 商品总额]，与 createOrder 原内联逻辑完全一致。
function computeCouponDiscountFen(goodsTotalFen, coupon) {
  if (!coupon) return 0
  const total = Number(goodsTotalFen) || 0
  let discountFen = 0
  if (coupon.type === 'cash') {
    const valueFen = Number.isInteger(coupon.valueFen) ? coupon.valueFen : toFen(coupon.value || 0)
    discountFen = Math.min(valueFen, total)
  } else if (coupon.type === 'discount') {
    const discountRate = (coupon.discount || 0) / 10
    discountFen = Math.round(total * (1 - discountRate))
  }
  return Math.max(0, Math.min(discountFen, total))
}

module.exports = {
  toFen,
  couponMinAmountFen,
  isCouponUsable,
  computeCouponDiscountFen
}

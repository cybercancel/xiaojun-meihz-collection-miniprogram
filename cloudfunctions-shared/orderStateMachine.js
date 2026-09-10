'use strict'
// 订单状态机与生命周期事务（单一来源，TASK-210）。
// 覆盖：状态流转校验、超时取消、退款成功、优惠券核销 / 返还。
// 依赖：./database（getDb/getCmd）、./logger。
// 由 scripts/sync-cloudfunction-shared.js 同步到各云函数，禁止在各云函数内联副本。
const { getDb, getCmd } = require('./database')
const { warn: logWarn } = require('./logger')

// 订单状态：0待支付 1待发货 2配送中 3已完成 4已取消 5退款申请中 6退款处理中 7已退款
const ORDER_TRANSITIONS = {
  0: [1, 4],
  1: [2, 3, 5], // 3=自取订单商家发货即视为完成（无需用户确认取货）
  2: [3, 5],
  3: [5],
  4: [],
  5: [1, 2, 3, 6, 7],
  6: [5, 7],
  7: []
}

// 【TASK-150】统一状态流转校验：非法跳转一律抛 INVALID_ORDER_TRANSITION
function assertOrderTransition(from, to) {
  if (!ORDER_TRANSITIONS.hasOwnProperty(from) || !ORDER_TRANSITIONS.hasOwnProperty(to)) {
    const e = new Error('订单状态非法: ' + from + '/' + to)
    e.code = 'INVALID_ORDER_TRANSITION'
    throw e
  }
  if (!ORDER_TRANSITIONS[from].includes(to)) {
    const e = new Error('订单状态流转不被允许: ' + from + '→' + to)
    e.code = 'INVALID_ORDER_TRANSITION'
    throw e
  }
}

// 【TASK-130/500】库存释放判据：仅当处于 RESERVED（已占用待支付）或历史订单（无该字段）才回滚，
// 防止重复释放。被 cancelOrder 与 expireOneOrder 共用，避免两处内联表达式漂移。
function shouldReleaseInventory(order) {
  return !!order && (order.inventoryStatus === 'RESERVED' || order.inventoryStatus === undefined)
}

// 超时取消单笔订单（事务内执行）。确认仍待支付且确实过期 → 释放库存 → 返还券 → 标记取消。
// 返回 true 表示已处理；false 表示无需处理（非待支付 / 未过期）。
async function expireOneOrder(transaction, order) {
  const db = getDb()
  const _ = getCmd()
  const fresh = await transaction.collection('orders').doc(order._id).get()
  const o = fresh.data
  if (!o || o.status !== 0) return false
  // 统一状态机校验：仅 0 → 4 合法
  assertOrderTransition(o.status, 4)
  if (!o.expireAt || new Date(o.expireAt).getTime() > Date.now()) return false

  // 释放库存（仅当处于预占态或历史订单，避免重复释放）
  const canRelease = shouldReleaseInventory(o)
  if (canRelease && Array.isArray(o.items)) {
    for (const item of o.items) {
      if (!item.productId || !item.quantity) continue
      await transaction.collection('products').doc(item.productId).update({
        data: { stock: _.inc(item.quantity), sales: _.inc(-item.quantity) }
      })
    }
  }

  // 返还优惠券：LOCKED(2)/旧数据(1) → 未过期 AVAILABLE(0,RETURNED) / 已过期 EXPIRED(3)
  if (o.couponId) {
    const ucRes = await transaction.collection('user_coupons').where({
      openid: o.openid, couponId: o.couponId, status: _.in([1, 2])
    }).get().catch(() => ({ data: [] }))
    const uc = ucRes.data && ucRes.data[0]
    const ownedByOther = uc && (
      (uc.status === 1 && uc.useOrderId && uc.useOrderId !== o._id) ||
      (uc.status === 2 && uc.lockedOrderId && uc.lockedOrderId !== o._id)
    )
    if (uc && !ownedByOther) {
      const expired = uc.expireTime && new Date(uc.expireTime).getTime() < Date.now()
      await transaction.collection('user_coupons').doc(uc._id).update({
        data: expired ? {
          status: 3, state: 'EXPIRED',
          lockedOrderId: null, lockedOrderNo: null, lockedAt: null,
          returnReason: 'SYSTEM_EXPIRED', returnedAt: db.serverDate()
        } : {
          status: 0, state: 'RETURNED',
          lockedOrderId: null, lockedOrderNo: null, lockedAt: null,
          usedTime: null,
          returnReason: 'SYSTEM_EXPIRED', returnedAt: db.serverDate()
        }
      }).catch(e => logWarn('expireOneOrder: coupon update failed', { err: e && e.message }))
    }
  }

  await transaction.collection('orders').doc(order._id).update({
    data: {
      status: 4,
      cancelSource: 'SYSTEM_EXPIRED',
      cancelReason: '订单超过支付时限',
      cancelledAt: db.serverDate(),
      inventoryStatus: 'RELEASED',
      inventoryReleasedAt: db.serverDate(),
      inventoryReleaseReason: 'SYSTEM_EXPIRED',
      updateTime: db.serverDate()
    }
  })
  return true
}

// 退款成功事务（与 wxRefundNotify / adminProcessRefund 共享）：
// refund PROCESSING/APPROVED → SUCCESS，order 6/5 → 7，payments → REFUNDED，并按规则返还券。
// 返回 { applied:boolean, reason?:string }
async function applyRefundSuccess(transaction, refundDoc, extra) {
  const db = getDb()
  const _ = getCmd()
  extra = extra || {}
  const fresh = await transaction.collection('refunds').doc(refundDoc._id).get()
  const r = fresh.data
  if (!r) return { applied: false, reason: 'REFUND_NOT_FOUND' }
  // 幂等：已成功则跳过
  if (r.status === 'SUCCESS') return { applied: false, reason: 'ALREADY_SUCCESS' }
  if (!['APPROVED', 'PROCESSING'].includes(r.status)) {
    return { applied: false, reason: 'INVALID_REFUND_STATUS:' + r.status }
  }

  const orderRes = await transaction.collection('orders').doc(r.orderId).get()
  const order = orderRes.data
  if (!order) return { applied: false, reason: 'ORDER_NOT_FOUND' }
  if (order.status === 7) {
    // 订单已退款，补齐 refund 状态即可（幂等）
    await transaction.collection('refunds').doc(r._id).update({
      data: { status: 'SUCCESS', successAt: db.serverDate(), updatedAt: db.serverDate() }
    })
    return { applied: true, reason: 'ORDER_ALREADY_REFUNDED' }
  }
  assertOrderTransition(order.status, 7) // 仅 5/6 → 7 合法

  await transaction.collection('refunds').doc(r._id).update({
    data: {
      status: 'SUCCESS',
      wechatRefundId: extra.wechatRefundId || r.wechatRefundId || '',
      settlementRefundFeeFen: extra.settlementRefundFeeFen !== undefined ? extra.settlementRefundFeeFen : null,
      successAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })
  await transaction.collection('orders').doc(r.orderId).update({
    data: {
      status: 7,
      completeTime: db.serverDate(),
      refund: Object.assign({}, order.refund, {
        processedAt: db.serverDate(),
        result: 'approved',
        refundNo: r.refundNo
      }),
      updateTime: db.serverDate()
    }
  })
  // payments 记录同步为已退款（可能不存在，容错）
  await transaction.collection('payments').where({ orderNo: r.orderNo }).update({
    data: { status: 'REFUNDED', refundNo: r.refundNo, refundedAt: db.serverDate() }
  }).catch(() => {})

  // 退款返券规则：订单未履约（退款申请前状态为 1 待发货）且 全额退款 且 券未过期
  if (order.couponId) {
    const paidFen = Number.isInteger(order.totalFen) ? order.totalFen : Math.round((order.totalPrice || 0) * 100)
    const isFullRefund = Number(r.refundAmountFen) >= paidFen - 1
    if (r.prevStatus === 1 && isFullRefund) {
      const ucRes = await transaction.collection('user_coupons').where({
        openid: order.openid, couponId: order.couponId, status: _.in([1, 2])
      }).get().catch(() => ({ data: [] }))
      const uc = ucRes.data && ucRes.data[0]
      const ownedByThis = uc && (
        (uc.status === 1 && (!uc.useOrderId || uc.useOrderId === order._id)) ||
        (uc.status === 2 && (!uc.lockedOrderId || uc.lockedOrderId === order._id))
      )
      if (uc && ownedByThis) {
        const expired = uc.expireTime && new Date(uc.expireTime).getTime() < Date.now()
        if (!expired) {
          await transaction.collection('user_coupons').doc(uc._id).update({
            data: {
              status: 0, state: 'RETURNED',
              useOrderId: null, useOrderNo: null, usedTime: null, useTime: null,
              lockedOrderId: null, lockedOrderNo: null, lockedAt: null,
              returnReason: 'REFUND_FULL_UNFULFILLED', returnedAt: db.serverDate()
            }
          }).catch(e => logWarn('applyRefundSuccess: coupon return failed', { err: e && e.message }))
        }
      }
    }
  }
  return { applied: true }
}

// 支付成功核销优惠券：LOCKED(2) → USED(1)（兼容旧数据下单即置 1）。
async function settleCouponForOrder(transaction, order) {
  const db = getDb()
  const _ = getCmd()
  if (!order.couponId) return
  const ucRes = await transaction.collection('user_coupons').where({
    openid: order.openid, couponId: order.couponId, status: _.in([1, 2])
  }).get().catch(() => ({ data: [] }))
  const uc = ucRes.data && ucRes.data[0]
  if (!uc) return
  // 归属校验：券被其他订单锁定 / 核销则不动。
  // 注意：支付前置流程中，券在「发起支付」即被锁定，锁定键为【意图号/意图_id】
  //        (lockedOrderNo=intentNo, lockedOrderId=intent._id)，而此时真实订单尚未落库；
  //        待微信回调建单后，order._id 与 intent._id 不同，故此处须同时允许
  //        lockedOrderNo 命中本订单号 OR 本意图号，否则券将永远卡在 LOCKED 无法核销。
  if (uc.status === 2 && uc.lockedOrderNo &&
      uc.lockedOrderNo !== order.orderNo && uc.lockedOrderNo !== order.intentNo) return
  if (uc.status === 1 && uc.useOrderId && uc.useOrderId !== order._id) return
  await transaction.collection('user_coupons').doc(uc._id).update({
    data: {
      status: 1,
      state: 'USED',
      useOrderId: order._id,
      useOrderNo: order.orderNo || null,
      useTime: db.serverDate(),
      // 核销后清除锁定指针，避免退款返还时误判归属
      lockedOrderId: null,
      lockedOrderNo: null,
      lockedAt: null
    }
  }).catch(e => logWarn('settleCouponForOrder: coupon update failed', { err: e && e.message }))
}

// 从支付意图(pay_intents)原子建单：微信回调确认支付成功 / 模拟支付直接确认时调用。
// 在建单事务内：写 orders(status:1, CONFIRMED) + 标记意图 PAID + 核销券 + 写 payments。
// 幂等：若意图已 PAID（微信重复推送 / 并发），返回既有订单 _id，不重复建单。
// 返回 { orderId, alreadyBuilt }。
async function buildOrderFromIntent(transaction, intent, opts) {
  const db = getDb()
  const _ = getCmd()
  opts = opts || {}
  // 重新读取意图，确认仍 PENDING（乐观并发，防微信重复推送重复建单）
  const fresh = await transaction.collection('pay_intents').doc(intent._id).get()
  const it = fresh.data
  if (!it) return { orderId: null, alreadyBuilt: false, missing: true }
  if (it.status === 'PAID' && it.orderId) {
    return { orderId: it.orderId, alreadyBuilt: true }
  }
  if (it.status !== 'PENDING') {
    // EXPIRED / FAILED：支付来得太晚，拒绝建单（库存/券已被回滚）
    return { orderId: null, alreadyBuilt: false, rejected: true }
  }

  const orderData = {
    orderNo: it.orderNo,
    openid: it.openid,
    items: it.items,
    address: it.address,
    deliveryType: it.deliveryType,
    goodsTotal: it.goodsTotal,
    goodsTotalFen: it.goodsTotalFen,
    discount: it.discount,
    discountFen: it.discountFen,
    deliveryFee: (typeof it.deliveryFee === 'number') ? it.deliveryFee : 0,
    deliveryFeeFen: (typeof it.deliveryFeeFen === 'number') ? it.deliveryFeeFen : 0,
    totalPrice: it.totalPrice,
    totalFen: it.totalFen,
    remark: it.remark || '',
    couponId: it.couponId || null,
    couponName: it.couponName || '',
    // 【TASK-290】支付前置：订单仅在支付确认成功时落库，永远不会有 status:0（待支付）
    status: 1, // 1: 已支付
    inventoryStatus: 'CONFIRMED',
    inventoryReservedAt: it.createTime,
    inventoryConfirmedAt: db.serverDate(),
    inventoryReleasedAt: null,
    inventoryReleaseReason: null,
    payStatus: 1,
    payTime: opts.paidAt || db.serverDate(),
    transactionId: opts.transactionId || '',
    payMethod: opts.payMethod || 'wechat',
    createTime: it.createTime,
    updateTime: db.serverDate()
  }

  const addRes = await transaction.collection('orders').add({ data: orderData })

  await transaction.collection('pay_intents').doc(intent._id).update({
    data: {
      status: 'PAID',
      paidAt: db.serverDate(),
      orderId: addRes._id,
      orderNo: it.orderNo
    }
  })

  // 核销优惠券 LOCKED(2) → USED(1)（settleCouponForOrder 内部按 openid+couponId 定位，并清除锁定指针）
  await settleCouponForOrder(transaction, {
    _id: addRes._id,
    openid: it.openid,
    couponId: it.couponId,
    orderNo: it.orderNo,
    intentNo: it.intentNo
  })

  await transaction.collection('payments').add({
    data: {
      orderNo: it.orderNo,
      orderId: addRes._id,
      openid: it.openid,
      transactionId: opts.transactionId || '',
      status: 'PAY_SUCCESS',
      totalFeeFen: it.totalFen,
      amount: (typeof it.totalFen === 'number') ? it.totalFen / 100 : 0,
      payMethod: opts.payMethod || 'wechat',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })

  return { orderId: addRes._id, alreadyBuilt: false }
}

// 超时/失败回滚支付意图（事务内执行）：释放已扣库存 + 解锁券 + 标记意图 EXPIRED。
// 返回 true 表示已处理；false 表示无需处理（非 PENDING / 已过期未到）。
async function rollbackPayIntent(transaction, intent) {
  const db = getDb()
  const _ = getCmd()
  const fresh = await transaction.collection('pay_intents').doc(intent._id).get()
  const it = fresh.data
  if (!it || it.status !== 'PENDING') return false

  // 释放库存（与 expireOneOrder 同款逻辑）
  if (Array.isArray(it.items)) {
    for (const item of it.items) {
      if (!item.productId || !item.quantity) continue
      await transaction.collection('products').doc(item.productId).update({
        data: { stock: _.inc(item.quantity), sales: _.inc(-item.quantity) }
      })
    }
  }

  // 解锁本意图锁定的优惠券：仅当仍被本意图锁定才动，避免误动其他订单的券
  if (it.couponId) {
    const ucRes = await transaction.collection('user_coupons').where({
      openid: it.openid, couponId: it.couponId, status: 2
    }).get().catch(() => ({ data: [] }))
    const uc = ucRes.data && ucRes.data[0]
    if (uc) {
      const ownedByOther = uc.lockedOrderId && uc.lockedOrderId !== intent._id
      if (!ownedByOther) {
        const expired = uc.expireTime && new Date(uc.expireTime).getTime() < Date.now()
        await transaction.collection('user_coupons').doc(uc._id).update({
          data: expired ? {
            status: 3, state: 'EXPIRED',
            lockedOrderId: null, lockedOrderNo: null, lockedAt: null,
            returnReason: 'SYSTEM_EXPIRED', returnedAt: db.serverDate()
          } : {
            status: 0, state: 'RETURNED',
            lockedOrderId: null, lockedOrderNo: null, lockedAt: null,
            usedTime: null,
            returnReason: 'SYSTEM_EXPIRED', returnedAt: db.serverDate()
          }
        }).catch(e => logWarn('rollbackPayIntent: coupon unlock failed', { err: e && e.message }))
      }
    }
  }

  await transaction.collection('pay_intents').doc(intent._id).update({
    data: {
      status: 'EXPIRED',
      expiredAt: db.serverDate(),
      expireReason: 'TIMEOUT_OR_FAILED'
    }
  })
  return true
}

// 订单取消 / 退款返还优惠券：LOCKED(2) → 未过期 AVAILABLE(0,state=RETURNED) / 已过期 EXPIRED(3)。
// 兼容旧数据（历史订单下单即将券置 status=1）：status ∈ [1,2] 均按锁定处理，但已被其他订单核销的不动。
async function returnCouponForOrder(transaction, order, reason) {
  const db = getDb()
  const _ = getCmd()
  if (!order.couponId) return
  const ucRes = await transaction.collection('user_coupons').where({
    openid: order.openid,
    couponId: order.couponId,
    status: _.in([1, 2])
  }).get().catch(() => ({ data: [] }))
  const uc = ucRes.data && ucRes.data[0]
  if (!uc) return
  // 若券已被核销且核销订单不是本单，说明属于其他订单，禁止返还
  if (uc.status === 1 && uc.useOrderId && uc.useOrderId !== order._id) return
  if (uc.status === 2 && uc.lockedOrderId && uc.lockedOrderId !== order._id) return
  const expired = uc.expireTime && new Date(uc.expireTime).getTime() < Date.now()
  await transaction.collection('user_coupons').doc(uc._id).update({
    data: expired ? {
      status: 3, state: 'EXPIRED',
      lockedOrderId: null, lockedOrderNo: null, lockedAt: null,
      returnReason: reason, returnedAt: db.serverDate()
    } : {
      status: 0, state: 'RETURNED',
      lockedOrderId: null, lockedOrderNo: null, lockedAt: null,
      usedTime: null,
      returnReason: reason, returnedAt: db.serverDate()
    }
  }).catch(e => logWarn('returnCouponForOrder: coupon update failed', { err: e && e.message }))
}

module.exports = {
  ORDER_TRANSITIONS,
  assertOrderTransition,
  shouldReleaseInventory,
  expireOneOrder,
  applyRefundSuccess,
  settleCouponForOrder,
  returnCouponForOrder,
  buildOrderFromIntent,
  rollbackPayIntent
}

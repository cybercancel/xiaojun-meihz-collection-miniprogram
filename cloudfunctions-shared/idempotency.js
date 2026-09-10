// idempotency.js — 写操作幂等键工具（TASK-310）
//
// 设计目标：关键写操作（下单/领券/评价/退款/管理退款/支付）防重复提交。
// 客户端生成 clientRequestId 并随请求带上；服务端以 key 去重：
//   - 已完成(done)：直接回放(replay)首次结果，不重复创建（连点两次返回同一订单）
//   - 处理中(processing)：并发重复，返回 DUPLICATE_REQUEST 拒绝
//   - 失败(failed)：允许用同一 clientRequestId 重试（不污染后续真实重试）
//   - 不存在(new)：预留(processing)进入正常流程，依赖集合唯一索引防止并发双写
//
// 集合：idempotency_keys，唯一索引见 createIndexes（key 字段 unique）
// best-effort：任何存储异常都不阻断主流程，仅降级为"不幂等"。

const cloud = require('wx-server-sdk')
const db = cloud.database()
const _ = db.command

const COLL = 'idempotency_keys'

// 检查当前 key 状态
async function checkIdempotency(key) {
  const res = await db.collection(COLL).where({ key }).limit(1).get()
  if (res.data && res.data.length > 0) {
    const rec = res.data[0]
    if (rec.status === 'done') return { status: 'done', result: rec.result, id: rec._id }
    if (rec.status === 'failed') return { status: 'failed', id: rec._id }
    return { status: 'processing', id: rec._id }
  }
  return { status: 'new' }
}

// 预留处理中。依赖唯一索引 key 防并发重复；冲突即视为他人已占用。
async function reserveIdempotency(key, openid) {
  try {
    const addRes = await db.collection(COLL).add({
      data: {
        key,
        openid: openid || '',
        status: 'processing',
        createdAt: db.serverDate()
      }
    })
    return { ok: true, id: addRes._id }
  } catch (e) {
    // 唯一索引冲突 / 其它写入异常：重新查询状态后返回
    let state = null
    try { state = await checkIdempotency(key) } catch (_) { /* ignore */ }
    return { ok: false, conflict: true, state }
  }
}

async function completeIdempotency(id, result) {
  if (!id) return
  await db.collection(COLL).doc(id).update({
    data: { status: 'done', result, completedAt: db.serverDate() }
  }).catch(() => {})
}

async function failIdempotency(id) {
  if (!id) return
  await db.collection(COLL).doc(id).update({
    data: { status: 'failed', completedAt: db.serverDate() }
  }).catch(() => {})
}

// 统一获取幂等锁：返回 { replay, id, duplicate }
//   replay   : 命中已完成记录，调用方应直接 return replay
//   id        : 已预留的处理中记录 _id，调用方成功时调用 completeIdempotency(id, result)
//   duplicate : true 表示并发重复提交，调用方应拒绝
async function acquireIdempotency(key, openid) {
  const st = await checkIdempotency(key).catch(() => ({ status: 'new' }))
  if (st.status === 'done') return { replay: st.result, id: null, duplicate: false }

  const r = await reserveIdempotency(key, openid)
  if (r.ok) return { replay: null, id: r.id, duplicate: false }

  // 预留冲突：重新判定
  const st2 = r.state || (await checkIdempotency(key).catch(() => ({ status: 'new' })))
  if (st2.status === 'done') return { replay: st2.result, id: null, duplicate: false }
  if (st2.status === 'processing') return { replay: null, id: null, duplicate: true }

  // failed：允许本次作为重试，重新预留一次
  const r2 = await reserveIdempotency(key, openid)
  if (r2.ok) return { replay: null, id: r2.id, duplicate: false }
  // 仍冲突但无法确定状态（集合不存在/基础设施不可用）：fail-open，不阻断主流程，
  // 仅降级为"本次不做幂等保护"。绝不可误判为重复提交而拒绝正常请求。
  console.warn('[idempotency] 无法确认幂等状态，降级为不幂等（fail-open）:', key)
  return { replay: null, id: null, duplicate: false }
}

module.exports = {
  IDEMPOTENCY_COLL: COLL,
  checkIdempotency,
  reserveIdempotency,
  completeIdempotency,
  failIdempotency,
  acquireIdempotency
}

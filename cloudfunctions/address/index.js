// 云函数：address
// 功能：多地址簿（增删改查 + 设默认），按 openid 隔离
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const COLLECTION = 'addresses'

// 【TASK-420】共享分页工具
const { normalizePage } = require('./pagination')

// HTML 特殊字符转义，防止 XSS
function escapeHtml(text) {
  if (!text || typeof text !== 'string') return ''
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }
  return text.replace(/[&<>"']/g, m => map[m])
}

// 清洗并校验地址输入；合法返回规范对象，不合法返回 null
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null

  const name = raw.name ? String(raw.name).trim().substring(0, 30) : ''
  const phone = raw.phone ? String(raw.phone).replace(/[^\d]/g, '').substring(0, 15) : ''
  const province = raw.province ? escapeHtml(String(raw.province).trim().substring(0, 30)) : ''
  const city = raw.city ? escapeHtml(String(raw.city).trim().substring(0, 30)) : ''
  const district = raw.district ? escapeHtml(String(raw.district).trim().substring(0, 30)) : ''
  const detail = raw.detail ? escapeHtml(String(raw.detail).trim().substring(0, 200)) : ''
  const tag = raw.tag ? escapeHtml(String(raw.tag).trim().substring(0, 10)) : ''

  if (!name || !phone || !detail) return null
  if (phone.length < 7 || phone.length > 15) return null

  const fullAddress = province + city + district + detail
  return {
    name: escapeHtml(name),
    phone,
    province,
    city,
    district,
    detail,
    tag,
    fullAddress
  }
}

// 统一返回文档（过滤系统字段）
function pickFields(doc) {
  return {
    _id: doc._id,
    name: doc.name,
    phone: doc.phone,
    province: doc.province,
    city: doc.city,
    district: doc.district,
    detail: doc.detail,
    tag: doc.tag,
    fullAddress: doc.fullAddress,
    isDefault: !!doc.isDefault
  }
}

// 【TASK-350】事务内清除某用户全部默认地址。
// 仅使用 .where().get() + 逐条 .doc().update()，规避事务内 .where().update() 的 SDK 兼容性风险。
async function clearDefaultsInTx(t, openid) {
  const res = await t.collection(COLLECTION).where({ openid, isDefault: true }).get()
  for (const d of (res.data || [])) {
    await t.collection(COLLECTION).doc(d._id).update({ data: { isDefault: false } })
  }
}

const { wrap } = require('./logger')
exports.main = wrap('address', async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, error: '用户未登录' }

  const { action } = event

  try {
    // 列表
    if (action === 'getList') {
      // 【TASK-420】分页标准化（maxPageSize=50 上限保护；默认 pageSize=50 兼容旧客户端一次取全）
      const { page, pageSize, skip } = normalizePage(event, { maxPageSize: 50, defaultPageSize: 50 })
      const countRes = await db.collection(COLLECTION).where({ openid: OPENID }).count()
      const total = countRes.total
      const res = await db.collection(COLLECTION).where({ openid: OPENID })
        .orderBy('isDefault', 'desc')
        .orderBy('updateTime', 'desc')
        .skip(skip)
        .limit(pageSize)
        .get()
      const list = (res.data || []).map(pickFields)
      const def = list.find(a => a.isDefault)
      return {
        success: true,
        data: {
          list,
          defaultId: def ? def._id : '',
          total,
          page,
          pageSize,
          hasMore: skip + pageSize < total
        }
      }
    }

    // 单个详情
    if (action === 'getOne') {
      const id = event.id
      if (!id) return { success: false, error: '缺少地址ID' }
      const doc = await db.collection(COLLECTION).doc(id).get().catch(() => null)
      if (!doc || !doc.data || doc.data.openid !== OPENID) {
        return { success: false, error: '地址不存在' }
      }
      return { success: true, data: pickFields(doc.data) }
    }

    // 新增
    if (action === 'add') {
      const clean = sanitize(event.address)
      if (!clean) return { success: false, error: '请填写完整且有效的收货信息' }

      const count = await db.collection(COLLECTION).where({ openid: OPENID }).count()
      let isDefault = !!event.address.isDefault
      if (count.total === 0) isDefault = true

      const now = db.serverDate()
      const doc = { openid: OPENID, ...clean, isDefault, createTime: now, updateTime: now }

      // 【TASK-350】默认地址设置纳入事务，保证并发下唯一默认
      const transaction = await db.startTransaction()
      try {
        if (isDefault) await clearDefaultsInTx(transaction, OPENID)
        const addRes = await transaction.collection(COLLECTION).add({ data: doc })
        await transaction.commit()
        return { success: true, data: { _id: addRes._id, ...clean, isDefault } }
      } catch (e) {
        await transaction.rollback().catch(() => {})
        console.error('[address.add] 事务失败:', e)
        return { success: false, error: '新增地址失败，请重试' }
      }
    }

    // 更新
    if (action === 'update') {
      const id = event.id
      if (!id) return { success: false, error: '缺少地址ID' }
      const clean = sanitize(event.address)
      if (!clean) return { success: false, error: '请填写完整且有效的收货信息' }

      const exist = await db.collection(COLLECTION).doc(id).get().catch(() => null)
      if (!exist || !exist.data || exist.data.openid !== OPENID) {
        return { success: false, error: '地址不存在' }
      }

      const willDefault = !!event.address.isDefault

      // 【TASK-350】默认地址切换纳入事务
      const transaction = await db.startTransaction()
      try {
        if (willDefault && !exist.data.isDefault) {
          await clearDefaultsInTx(transaction, OPENID)
        }
        await transaction.collection(COLLECTION).doc(id).update({
          data: { ...clean, isDefault: willDefault, updateTime: db.serverDate() }
        })
        await transaction.commit()
        return { success: true, data: { _id: id, ...clean, isDefault: willDefault } }
      } catch (e) {
        await transaction.rollback().catch(() => {})
        console.error('[address.update] 事务失败:', e)
        return { success: false, error: '更新地址失败，请重试' }
      }
    }

    // 删除
    if (action === 'delete') {
      const id = event.id
      if (!id) return { success: false, error: '缺少地址ID' }
      const exist = await db.collection(COLLECTION).doc(id).get().catch(() => null)
      if (!exist || !exist.data || exist.data.openid !== OPENID) {
        return { success: false, error: '地址不存在' }
      }
      const wasDefault = !!exist.data.isDefault

      // 【TASK-350】删除 + 重新选择默认地址在同一事务内原子完成
      const transaction = await db.startTransaction()
      try {
        await transaction.collection(COLLECTION).doc(id).remove()
        // 若删除的是默认地址，按更新时间规则提升最近一条为默认
        if (wasDefault) {
          const rest = await transaction.collection(COLLECTION).where({ openid: OPENID })
            .orderBy('updateTime', 'desc').limit(1).get()
          if (rest.data && rest.data.length) {
            await transaction.collection(COLLECTION).doc(rest.data[0]._id)
              .update({ data: { isDefault: true } })
          }
        }
        await transaction.commit()
        return { success: true, data: { _id: id } }
      } catch (e) {
        await transaction.rollback().catch(() => {})
        console.error('[address.delete] 事务失败:', e)
        return { success: false, error: '删除地址失败，请重试' }
      }
    }

    // 设为默认
    if (action === 'setDefault') {
      const id = event.id
      if (!id) return { success: false, error: '缺少地址ID' }
      const exist = await db.collection(COLLECTION).doc(id).get().catch(() => null)
      if (!exist || !exist.data || exist.data.openid !== OPENID) {
        return { success: false, error: '地址不存在' }
      }

      // 【TASK-350】默认地址设置使用事务：先清除全部默认，再置目标为默认，原子保证唯一默认
      const transaction = await db.startTransaction()
      try {
        await clearDefaultsInTx(transaction, OPENID)
        await transaction.collection(COLLECTION).doc(id).update({
          data: { isDefault: true, updateTime: db.serverDate() }
        })
        await transaction.commit()
        return { success: true, data: { _id: id } }
      } catch (e) {
        await transaction.rollback().catch(() => {})
        console.error('[address.setDefault] 事务失败:', e)
        return { success: false, error: '设置默认地址失败，请重试' }
      }
    }

    return { success: false, error: '未知操作' }
  } catch (e) {
    console.error('address error:', e)
    return { success: false, error: '操作失败，请重试' }
  }
})

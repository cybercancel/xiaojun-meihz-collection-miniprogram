// 云函数：管理员添加优惠券
const cloud = require('wx-server-sdk')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})
const db = cloud.database()

// 使用共享鉴权模块
const { verifyAdmin } = require('./adminAuth')
const { logAudit, ACTIONS, adminCtx } = require('./audit')


const { wrap } = require('./logger')
exports.main = wrap('adminAddCoupon', async (event, context) => {
  try {
    // Verify admin identity
    var authError = await verifyAdmin(event, db, { permissions: ["coupon.manage"] })
    if (authError) return authError

    const { couponData } = event
    
    if (!couponData || !couponData.name) {
      return {
        success: false,
        error: '优惠券名称不能为空'
      }
    }
    
    // 折扣券必须有 discount 字段，满减券必须有 value 字段
    if (couponData.type === 'discount' && !couponData.discount) {
      return {
        success: false,
        error: '折扣券折扣率不能为空'
      }
    }
    if (couponData.type !== 'discount' && !couponData.value) {
      return {
        success: false,
        error: '满减券面值不能为空'
      }
    }
    
    // 允许的字段
    const allowedFields = [
      'name', 'value', 'discount', 'minAmount', 'validDays', 'description',
      'type', 'status', 'sort', 'totalCount', 'receiveCount', 'receiveEndTime',
      '适用商品', '适用分类'
    ]
    
    // 过滤字段
    const filteredData = {}
    for (const field of allowedFields) {
      if (couponData[field] !== undefined) {
        filteredData[field] = couponData[field]
      }
    }
    
    // 设置默认值
    if (filteredData.status === undefined) {
      filteredData.status = 1 // 默认上架
    }
    if (filteredData.sort === undefined) {
      filteredData.sort = 0
    }
    if (filteredData.minAmount === undefined) {
      filteredData.minAmount = 0
    }
    if (filteredData.validDays === undefined) {
      filteredData.validDays = 30
    }
    if (filteredData.type === undefined) {
      filteredData.type = 'discount' // discount: 折扣券, cash: 满减券
    }
    if (filteredData.totalCount === undefined) {
      filteredData.totalCount = 1000
    }
    if (filteredData.receiveCount === undefined) {
      filteredData.receiveCount = 0
    }
    // 折扣券若无 discount 但给了 value，从 value 推导
    if (filteredData.type === 'discount' && filteredData.discount === undefined && filteredData.value !== undefined) {
      filteredData.discount = filteredData.value
    }
    
    // 添加时间
    filteredData.createTime = db.serverDate()
    filteredData.updateTime = db.serverDate()
    
    // 添加优惠券
    const result = await db.collection('coupons').add({
      data: filteredData
    })

    // TASK-240 审计：新增优惠券模板
    const ctx = adminCtx(event)
    await logAudit(db, {
      requestId: event.requestId,
      adminId: ctx.adminId,
      adminRole: ctx.adminRole,
      action: ACTIONS.COUPON_TEMPLATE_ADD,
      targetType: 'coupon',
      targetId: result._id,
      after: { _id: result._id, ...filteredData },
      result: 'SUCCESS'
    })

    return {
      success: true,
      data: {
        _id: result._id,
        ...filteredData
      },
      message: '添加成功'
    }
    
  } catch (error) {
    console.error('添加优惠券失败:', error)
    return {
      success: false,
      error: error.message
    }
  }
})

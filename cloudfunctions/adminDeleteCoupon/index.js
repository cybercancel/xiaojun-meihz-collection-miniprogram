// 云函数：管理员删除优惠券
const cloud = require('wx-server-sdk')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})
const db = cloud.database()

// 使用共享鉴权模块
const { verifyAdmin } = require('./adminAuth')


const { wrap } = require('./logger')
exports.main = wrap('adminDeleteCoupon', async (event, context) => {
  try {
    // Verify admin identity
    var authError = await verifyAdmin(event, db, { permissions: ["coupon.manage"] })
    if (authError) return authError

    const { couponId } = event
    
    if (!couponId) {
      return {
        success: false,
        error: '优惠券ID不能为空'
      }
    }
    
    // 删除优惠券
    await db.collection('coupons')
      .doc(couponId)
      .remove()
    
    return {
      success: true,
      message: '删除成功'
    }
    
  } catch (error) {
    console.error('删除优惠券失败:', error)
    return {
      success: false,
      error: error.message
    }
  }
})

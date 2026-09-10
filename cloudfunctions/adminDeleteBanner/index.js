// 管理员删除横幅云函数
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 使用共享鉴权模块
const { verifyAdmin } = require('./adminAuth')
const { bumpVersion } = require('./cacheVersion')

const _ = db.command

const { wrap } = require('./logger')
exports.main = wrap('adminDeleteBanner', async (event, context) => {
  try {
    const { id } = event
    if (!id) {
      return {
        success: false,
        message: '横幅ID不能为空'
      }
    }

    // 验证管理员token（统一走共享 verifyAdmin，fail-close）
    const authError = await verifyAdmin(event, db, { permissions: ["banner.manage"] })
    if (authError) return authError

    // 检查横幅是否存在
    const bannerRes = await db.collection('banners').doc(id).get()
    if (!bannerRes.data) {
      return {
        success: false,
        message: '横幅不存在'
      }
    }

    // 删除横幅
    await db.collection('banners').doc(id).remove()

    // 【TASK-430】主动失效轮播缓存（best-effort，失败不影响本次写操作的成功返回）
    await bumpVersion('banners')

    return {
      success: true,
      message: '删除成功'
    }
  } catch (error) {
    console.error('删除横幅失败:', error)
    return {
      success: false,
      message: '删除失败：' + error.message
    }
  }
})

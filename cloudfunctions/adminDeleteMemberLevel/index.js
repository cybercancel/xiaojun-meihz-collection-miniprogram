// 云函数：管理员删除会员等级
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 使用共享鉴权模块
const { verifyAdmin } = require('./adminAuth')
const { bumpVersion } = require('./cacheVersion')


const { wrap } = require('./logger')
exports.main = wrap('adminDeleteMemberLevel', async (event, context) => {
  try {
    const { levelId } = event

    // 验证管理员token（统一走共享 verifyAdmin，fail-close）
    const authError = await verifyAdmin(event, db, { permissions: ["memberlevel.manage"] })
    if (authError) return authError

    if (!levelId) {
      return { success: false, error: '等级ID不能为空' }
    }

    await db.collection('member_levels').doc(levelId).remove()

    // 【TASK-430】主动失效会员等级缓存（best-effort，失败不影响本次写操作的成功返回）
    await bumpVersion('memberLevels')

    return { success: true, message: '删除成功' }
  } catch (error) {
    console.error('删除会员等级失败:', error)
    return { success: false, error: error.message }
  }
})

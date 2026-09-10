// 云函数：管理员添加会员等级
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 使用共享鉴权模块
const { verifyAdmin } = require('./adminAuth')
const { bumpVersion } = require('./cacheVersion')


const { wrap } = require('./logger')
exports.main = wrap('adminAddMemberLevel', async (event, context) => {
  try {
    const { levelData } = event

    // 验证管理员token（统一走共享 verifyAdmin，fail-close）
    const authError = await verifyAdmin(event, db, { permissions: ["memberlevel.manage"] })
    if (authError) return authError

    if (!levelData || !levelData.name) {
      return { success: false, error: '等级名称不能为空' }
    }
    if (!levelData.levelValue) {
      return { success: false, error: '等级值不能为空' }
    }

    const allowedFields = [
      'name', 'levelValue', 'icon', 'discount', 'pointsRate',
      'upgradeAmount', 'benefits', 'status', 'sort', 'description'
    ]

    const filteredData = {}
    for (const field of allowedFields) {
      if (levelData[field] !== undefined) {
        filteredData[field] = levelData[field]
      }
    }

    // 默认值
    if (filteredData.status === undefined) filteredData.status = 1
    if (filteredData.sort === undefined) filteredData.sort = 0
    if (filteredData.discount === undefined) filteredData.discount = 1
    if (filteredData.pointsRate === undefined) filteredData.pointsRate = 1
    if (filteredData.upgradeAmount === undefined) filteredData.upgradeAmount = 0
    if (!filteredData.benefits) filteredData.benefits = []

    filteredData.createTime = db.serverDate()
    filteredData.updateTime = db.serverDate()

    const result = await db.collection('member_levels').add({ data: filteredData })

    // 【TASK-430】主动失效会员等级缓存（best-effort，失败不影响本次写操作的成功返回）
    await bumpVersion('memberLevels')

    return {
      success: true,
      data: { _id: result._id, ...filteredData },
      message: '添加成功'
    }
  } catch (error) {
    console.error('添加会员等级失败:', error)
    return { success: false, error: error.message }
  }
})

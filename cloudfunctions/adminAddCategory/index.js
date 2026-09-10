// 云函数：管理员新增分类
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const { verifyAdmin } = require('./adminAuth')
const { bumpVersion } = require('./cacheVersion')

const { wrap } = require('./logger')
exports.main = wrap('adminAddCategory', async (event, context) => {
  try {
    const authError = await verifyAdmin(event, db, { permissions: ["product.manage"] })
    if (authError) return authError

    const { name, icon, sort, status } = event
    if (!name || !name.trim()) {
      return { success: false, error: '分类名称不能为空' }
    }

    const addRes = await db.collection('categories').add({
      data: {
        name: name.trim(),
        icon: icon || '📦',
        sort: Number(sort) || 0,
        status: status !== undefined ? Number(status) : 1,
        createTime: db.serverDate(),
        updateTime: db.serverDate()
      }
    })

    // 【TASK-430】主动失效分类缓存（best-effort，失败不影响本次写操作的成功返回）
    await bumpVersion('categories')

    return {
      success: true,
      data: { _id: addRes._id },
      message: '新增成功'
    }
  } catch (error) {
    console.error('新增分类失败:', error)
    return { success: false, error: error.message }
  }
})

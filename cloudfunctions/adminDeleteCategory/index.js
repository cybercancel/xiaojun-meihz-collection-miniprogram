// 云函数：管理员删除分类
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const { verifyAdmin } = require('./adminAuth')
const { bumpVersion } = require('./cacheVersion')

const { wrap } = require('./logger')
exports.main = wrap('adminDeleteCategory', async (event, context) => {
  try {
    const authError = await verifyAdmin(event, db, { permissions: ["product.manage"] })
    if (authError) return authError

    const { categoryId } = event
    if (!categoryId) {
      return { success: false, error: '缺少分类ID' }
    }

    // 检查分类是否存在
    const existing = await db.collection('categories').doc(categoryId).get().catch(() => ({ data: null }))
    if (!existing.data) {
      return { success: false, error: '分类不存在' }
    }

    await db.collection('categories').doc(categoryId).remove()

    // 【TASK-430】主动失效分类缓存（best-effort，失败不影响本次写操作的成功返回）
    await bumpVersion('categories')

    return { success: true, message: '删除成功' }
  } catch (error) {
    console.error('删除分类失败:', error)
    return { success: false, error: error.message }
  }
})

// 管理员添加横幅云函数
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
exports.main = wrap('adminAddBanner', async (event, context) => {
  try {
    // 验证管理员token（统一走共享 verifyAdmin，fail-close）
    const authError = await verifyAdmin(event, db, { permissions: ["banner.manage"] })
    if (authError) return authError

    // 获取参数
    const { title, imageUrl, linkUrl = '', sort = 0, status = 1, description = '' } = event

    // 验证必填字段
    if (!title) {
      return {
        success: false,
        message: '横幅标题不能为空'
      }
    }

    if (!imageUrl) {
      return {
        success: false,
        message: '横幅图片不能为空'
      }
    }

    // 构建横幅数据
    const bannerData = {
      title: title,
      imageUrl: imageUrl,
      linkUrl: linkUrl,
      sort: sort,
      status: status,
      description: description,
      createTime: db.serverDate(),
      updateTime: db.serverDate()
    }

    // 添加横幅
    const res = await db.collection('banners').add({
      data: bannerData
    })

    // 获取添加后的数据
    const newBanner = await db.collection('banners').doc(res._id).get()

    // 【TASK-430】主动失效轮播缓存（best-effort，失败不影响本次写操作的成功返回）
    await bumpVersion('banners')

    return {
      success: true,
      message: '添加成功',
      data: newBanner.data
    }
  } catch (error) {
    console.error('添加横幅失败:', error)
    return {
      success: false,
      message: '添加失败：' + error.message
    }
  }
})

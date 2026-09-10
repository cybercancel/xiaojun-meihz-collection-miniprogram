// 云函数：管理员添加商品
const cloud = require('wx-server-sdk')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})
const db = cloud.database()

// 使用共享鉴权模块
const { verifyAdmin } = require('./adminAuth')
const { logAudit, ACTIONS, adminCtx } = require('./audit')
const { bumpVersion } = require('./cacheVersion')


const { wrap } = require('./logger')
exports.main = wrap('adminAddProduct', async (event, context) => {
  try {
    // Verify admin identity
    var authError = await verifyAdmin(event, db, { permissions: ["product.manage"] })
    if (authError) return authError

    const { productData } = event
    
    if (!productData || !productData.name) {
      return {
        success: false,
        error: '商品名称不能为空'
      }
    }
    
    if (!productData.price) {
      return {
        success: false,
        error: '商品价格不能为空'
      }
    }
    
    // 允许的字段
    // 【TASK-440】imageThumb / imagesThumb 为客户端生成并上传的缩略图（列表页使用）
    const allowedFields = [
      'name', 'price', 'pickupPrice', 'originalPrice', 'image', 'images',
      'imageThumb', 'imagesThumb',
      'description', 'categoryId', 'category', 'status', 'stock',
      'sales', 'sort', 'tags', 'specs',
      'isHot', 'isRecommend'
    ]
    
    // 过滤字段
    const filteredData = {}
    for (const field of allowedFields) {
      if (productData[field] !== undefined) {
        filteredData[field] = productData[field]
      }
    }
    
    // 设置默认值
    if (filteredData.status === undefined) {
      filteredData.status = 1 // 默认上架
    }
    if (filteredData.sales === undefined) {
      filteredData.sales = 0
    }
    if (filteredData.sort === undefined) {
      filteredData.sort = 0
    }
    if (filteredData.stock === undefined) {
      filteredData.stock = 999
    }
    
    // 添加时间
    filteredData.createTime = db.serverDate()
    filteredData.updateTime = db.serverDate()
    
    // 添加商品
    const result = await db.collection('products').add({
      data: filteredData
    })

    // TASK-240 审计：新增商品
    const ctx = adminCtx(event)
    await logAudit(db, {
      requestId: event.requestId,
      adminId: ctx.adminId,
      adminRole: ctx.adminRole,
      action: ACTIONS.PRODUCT_ADD,
      targetType: 'product',
      targetId: result._id,
      after: { _id: result._id, ...filteredData },
      result: 'SUCCESS'
    })

    // 【TASK-430】主动失效商品缓存（best-effort，失败不影响本次写操作的成功返回）
    await bumpVersion('products')

    return {
      success: true,
      data: {
        _id: result._id,
        ...filteredData
      },
      message: '商品添加成功'
    }
    
  } catch (error) {
    console.error('添加商品失败:', error)
    return {
      success: false,
      error: error.message
    }
  }
})

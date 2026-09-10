// cloudfunctions-shared/productImage.js
// 【TASK-440】图片「列表优先缩略图 / 预览用原图」的统一裁决（单一来源）
// 覆盖商品图（公开桶，直出 cloud://）与评价图（私有桶，需临时链接）两条链路。
//
// 背景：客户端 wxml/wxss 被布局锁冻结（layout-lock.json），不允许改动模板。
//       任务书要求"不得修改当前图片卡片布局，只替换图片URL来源"，
//       因此"列表优先使用缩略图"必须在**服务端返回数据时**完成来源替换：
//       列表接口把 image 替换成缩略图，详情接口保持原图。
//
// products 集合字段约定：
//   image          封面原图  （cloud://，已限制最长边 1600px 并压缩，用于详情/大图预览）
//   imageThumb     封面缩略图（cloud://，最长边 400px，用于列表卡片）
//   images[]       详情图集原图
//   imagesThumb[]  详情图集缩略图（与 images 下标对齐，允许缺失/稀疏）
//
// 安全约束（务必遵守）：
//   1. 只有**列表**接口做替换。getProductDetail 必须返回原图 —— 该函数同时被
//      管理端编辑页复用，若替换会导致保存时把缩略图写回 image，原图永久丢失。
//   2. 缩略图缺失一律回退原图，绝不返回空串（旧数据没有 thumb 字段）。
//   3. 订单商品快照 items[].image 是历史凭证，不得替换。

// 是否是一个可用的图片来源（cloud:// 或 http(s):// 或本地占位路径）
function isUsableImage(v) {
  return typeof v === 'string' && v.trim().length > 0
}

// 纯函数：缩略图优先，缺失回退原图
function pickThumb(thumb, origin) {
  if (isUsableImage(thumb)) return thumb.trim()
  return isUsableImage(origin) ? origin : ''
}

// 列表用：返回一个新对象，image 替换为缩略图；同时剔除体积无用的 imagesThumb
// 不修改入参，不影响 detail 链路。
function toListItem(product) {
  if (!product || typeof product !== 'object') return product
  const out = Object.assign({}, product)
  out.image = pickThumb(product.imageThumb, product.image)
  // 列表卡片只用一张图，图集缩略图数组无需下发
  if ('imagesThumb' in out) delete out.imagesThumb
  return out
}

// 批量版本
function toListItems(list) {
  if (!Array.isArray(list)) return []
  return list.map(toListItem)
}

// 收藏/多图卡片用：按下标对齐取缩略图，缺失回退同下标原图；
// 图集为空时回退封面（同样缩略图优先）。max 默认 2 张。
function pickCardImages(product, max) {
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : 2
  if (!product || typeof product !== 'object') return []
  const origins = Array.isArray(product.images) ? product.images : []
  const thumbs = Array.isArray(product.imagesThumb) ? product.imagesThumb : []

  const picked = []
  for (let i = 0; i < origins.length && picked.length < limit; i++) {
    const v = pickThumb(thumbs[i], origins[i])
    if (v) picked.push(v)
  }
  if (picked.length === 0) {
    const cover = pickThumb(product.imageThumb, product.image)
    if (cover) picked.push(cover)
  }
  return picked
}

// 私有图（评价图）专用：原图与缩略图都需要换成 HTTPS 临时链接后再下发。
// 返回两个下标严格对齐的数组：
//   grid → 卡片网格用（缩略图优先，缺失回退原图）
//   full → 大图预览用（始终原图，任务书要求"保留原图用于预览"）
// urlMap 为 fileID → tempFileURL 的映射；解析失败的项回退为原 fileID（与改造前行为一致）。
function buildDualImages(origins, thumbs, urlMap) {
  const o = Array.isArray(origins) ? origins : []
  const t = Array.isArray(thumbs) ? thumbs : []
  const m = urlMap || {}
  const full = o.map((f) => m[f] || f)
  const grid = o.map((f, i) => {
    const tf = t[i]
    if (tf && m[tf]) return m[tf]
    return m[f] || f
  })
  return { grid, full }
}

module.exports = {
  isUsableImage,
  pickThumb,
  toListItem,
  toListItems,
  pickCardImages,
  buildDualImages
}

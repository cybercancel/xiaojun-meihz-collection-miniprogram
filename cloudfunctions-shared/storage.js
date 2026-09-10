// cloudfunctions-shared/storage.js
// 云存储目录规范 + 上传校验 + 路径工具（单一来源）
//
// 目录划分（遵循任务书 111.txt TASK-250）：
//   public/products/   商品图片（公开可读）
//   public/banners/    轮播图（公开可读）
//   public/shop/       店铺Logo（公开可读）
//   private/reviews/{openid}/   评价图片（私有，按 openid 隔离）
//   private/avatars/{openid}/    头像（私有，按 openid 隔离；社交公开信息，读取放行）
//   private/refunds/{openid}/    退款凭证（私有，仅管理员经审计可见）
//
// 关键安全原则：
//   1. 上传路径由服务端根据真实 openid 生成，绝不信任客户端传入的任意路径。
//   2. 私有目录按 openid 隔离，A 用户无法写入 B 用户的私有前缀。
//   3. 读取权限在 getTempFileUrls 统一裁决，不依赖云存储物理 ACL。

const crypto = require('crypto')

// 业务桶配置
const BUCKETS = {
  product: { prefix: 'public/products/', public: true, scoped: false, maxSize: 5 * 1024 * 1024, ext: ['jpg', 'jpeg', 'png', 'webp'], maxCount: 9, label: '商品图片' },
  banner:  { prefix: 'public/banners/',  public: true, scoped: false, maxSize: 2 * 1024 * 1024, ext: ['jpg', 'jpeg', 'png', 'webp'], maxCount: 1, label: '轮播图' },
  shop:    { prefix: 'public/shop/',     public: true, scoped: false, maxSize: 2 * 1024 * 1024, ext: ['jpg', 'jpeg', 'png', 'webp'], maxCount: 1, label: '店铺Logo' },
  review:  { prefix: 'private/reviews/', public: false, scoped: true, maxSize: 5 * 1024 * 1024, ext: ['jpg', 'jpeg', 'png', 'webp'], maxCount: 9, label: '评价图片' },
  avatar:  { prefix: 'private/avatars/', public: false, scoped: true, maxSize: 2 * 1024 * 1024, ext: ['jpg', 'jpeg', 'png', 'webp'], maxCount: 1, label: '头像' },
  refund:  { prefix: 'private/refunds/', public: false, scoped: true, maxSize: 5 * 1024 * 1024, ext: ['jpg', 'jpeg', 'png', 'webp'], maxCount: 5, label: '退款凭证' }
}

const PRIVATE_PREFIXES = ['private/']
// 兼容迁移前的历史公开前缀（统一可读，避免破坏旧数据）
const LEGACY_PUBLIC_PREFIXES = ['reviews/', 'avatars/', 'products/', 'banners/', 'shop/', 'public/']

// 微信 openid 合法字符
const OPENID_RE = /^[a-zA-Z0-9_-]{1,64}$/

function genUUID() {
  return crypto.randomBytes(12).toString('hex')
}

function normalizeExt(ext) {
  if (!ext) return ''
  return String(ext).toLowerCase().replace(/^\./, '').replace(/[^a-z0-9]/g, '')
}

function buildStoragePath(type, openid, ext) {
  const b = BUCKETS[type]
  if (!b) throw new Error('未知上传类型: ' + type)
  const ne = normalizeExt(ext) || 'jpg'
  if (b.scoped) {
    if (!openid || !OPENID_RE.test(openid)) throw new Error('无效的用户标识')
    return `${b.prefix}${openid}/${genUUID()}.${ne}`
  }
  return `${b.prefix}${genUUID()}.${ne}`
}

// 校验上传元数据，返回 { ok, error, normalizedPath, public, bucket }
function validateUploadMeta(meta) {
  const { type, openid, size, mime, ext, count } = meta || {}
  const b = BUCKETS[type]
  if (!b) return { ok: false, error: '未知上传类型：' + type }
  if (b.scoped && (!openid || !OPENID_RE.test(openid))) {
    return { ok: false, error: '无效的用户标识' }
  }
  const ne = normalizeExt(ext)
  if (!ne || b.ext.indexOf(ne) < 0) {
    return { ok: false, error: `不支持的格式，仅允许：${b.ext.join('/')}` }
  }
  const sz = Number(size)
  // 大小上限校验：仅当客户端提供了有效 size 时校验；
  // 未提供（<=0）时跳过，依赖云存储平台自身的文件大小限额作为兜底。
  if (Number.isFinite(sz) && sz > 0 && sz > b.maxSize) {
    return { ok: false, error: `文件过大，最大 ${Math.round(b.maxSize / 1024 / 1024)}MB` }
  }
  if (count != null) {
    const c = Number(count)
    if (Number.isFinite(c) && c > b.maxCount) {
      return { ok: false, error: `单次最多上传 ${b.maxCount} 张` }
    }
  }
  if (mime && !/^image\//.test(String(mime))) {
    return { ok: false, error: '仅支持图片文件' }
  }
  const path = buildStoragePath(type, openid, ne)
  return { ok: true, normalizedPath: path, public: b.public, bucket: b }
}

// 从 cloud://env/path 提取纯路径
function extractCloudPath(fileID) {
  if (!fileID || typeof fileID !== 'string') return ''
  const m = fileID.match(/^cloud:\/\/[^/]+\/(.+)$/)
  return m ? m[1] : ''
}

function isPrivatePath(path) {
  return PRIVATE_PREFIXES.some(p => String(path).indexOf(p) === 0)
}

function isLegacyPublic(path) {
  return LEGACY_PUBLIC_PREFIXES.some(p => String(path).indexOf(p) === 0)
}

function getBucketByPrefix(path) {
  for (const k in BUCKETS) {
    if (path.indexOf(BUCKETS[k].prefix) === 0) return Object.assign({ type: k }, BUCKETS[k])
  }
  return null
}

// 校验私有路径是否归 openid 所有（scoped 类型按 openid 段比对）
function isOwnedBy(type, openid, path) {
  const b = BUCKETS[type]
  if (!b) return false
  if (b.scoped) {
    const ownerPrefix = `${b.prefix}${openid}/`
    return path.indexOf(ownerPrefix) === 0
  }
  return path.indexOf(b.prefix) === 0
}

module.exports = {
  BUCKETS,
  PRIVATE_PREFIXES,
  LEGACY_PUBLIC_PREFIXES,
  OPENID_RE,
  genUUID,
  normalizeExt,
  buildStoragePath,
  validateUploadMeta,
  extractCloudPath,
  isPrivatePath,
  isLegacyPublic,
  getBucketByPrefix,
  isOwnedBy
}

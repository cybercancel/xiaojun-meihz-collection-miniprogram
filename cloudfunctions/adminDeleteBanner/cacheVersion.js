// cacheVersion.js — 缓存版本中心（TASK-430）
//
// 设计目标：为"可缓存的低频变更数据"提供服务端权威版本号，实现主动失效。
//
// 任务书要求缓存必须同时具备三要素：
//   1. 版本      —— 本模块提供（cache_versions 集合，每个 namespace 一个单调递增整数）
//   2. 过期时间  —— 客户端 utils/cache.js 的 TTL 负责
//   3. 主动失效  —— 管理员写操作后 bumpVersion，客户端下次协商即失效
//
// 可缓存 namespace（任务书白名单）：
//   categories / banners / shopSettings / memberLevels / products
// 明确禁止长缓存（不在此模块管辖，客户端亦不得缓存）：
//   库存 / 订单状态 / 支付状态 / 退款状态 / 优惠券状态 / 用户积分
//
// 集合：cache_versions，_id 直接使用 namespace 字符串（天然唯一，无需额外索引）
// best-effort：任何存储异常都不阻断主流程，读失败降级为 0（视为"无有效缓存"→ 返回全量）。

const cloud = require('wx-server-sdk')
const db = cloud.database()
const _ = db.command

const COLL = 'cache_versions'

// 允许的缓存命名空间白名单。非白名单一律拒绝，防止被任意写入撑大集合。
const CACHE_NAMESPACES = {
  categories: 'categories',
  banners: 'banners',
  shopSettings: 'shopSettings',
  memberLevels: 'memberLevels',
  products: 'products'
}

const ALL_NAMESPACES = Object.keys(CACHE_NAMESPACES)

function isValidNamespace(ns) {
  return typeof ns === 'string' && Object.prototype.hasOwnProperty.call(CACHE_NAMESPACES, ns)
}

// 读取单个 namespace 的当前版本。不存在或异常一律返回 0。
// 返回 0 表示"服务端尚无版本记录"，配合 isNotModified 会强制返回全量数据。
async function getVersion(ns) {
  if (!isValidNamespace(ns)) return 0
  try {
    const res = await db.collection(COLL).doc(ns).get()
    const v = res && res.data ? Number(res.data.version) : NaN
    return Number.isFinite(v) && v > 0 ? v : 0
  } catch (e) {
    // 文档不存在 / 集合不存在 / 网络异常：降级为 0
    return 0
  }
}

// 批量读取版本，一次查询解决。缺失的 namespace 补 0。
async function getAllVersions(namespaces) {
  const list = Array.isArray(namespaces) && namespaces.length > 0
    ? namespaces.filter(isValidNamespace)
    : ALL_NAMESPACES

  const out = {}
  for (let i = 0; i < list.length; i++) out[list[i]] = 0

  try {
    const res = await db.collection(COLL).where({ _id: _.in(list) }).limit(list.length).get()
    const rows = (res && res.data) || []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const v = Number(row.version)
      if (isValidNamespace(row._id) && Number.isFinite(v) && v > 0) {
        out[row._id] = v
      }
    }
  } catch (e) {
    // 集合不存在等：全部保持 0，客户端将拿到全量数据
  }
  return out
}

// 递增版本号 = 主动失效。
// 先 inc（文档已存在的常见路径），失败再 add，add 并发冲突再 inc 一次。
// 全程 best-effort，返回 true/false 但调用方通常忽略——绝不能因为失效失败而让写操作报错。
async function bumpVersion(ns) {
  if (!isValidNamespace(ns)) return false

  try {
    const r = await db.collection(COLL).doc(ns).update({
      data: { version: _.inc(1), updateTime: db.serverDate() }
    })
    if (r && r.stats && r.stats.updated > 0) return true
  } catch (e) { /* 文档不存在，走下面的 add */ }

  try {
    await db.collection(COLL).add({
      data: { _id: ns, version: 1, updateTime: db.serverDate() }
    })
    return true
  } catch (e) {
    // 并发下别人刚创建成功导致 _id 冲突：再 inc 一次
    try {
      await db.collection(COLL).doc(ns).update({
        data: { version: _.inc(1), updateTime: db.serverDate() }
      })
      return true
    } catch (e2) {
      console.warn('[cacheVersion] bump 失败，缓存失效降级（不影响主流程）:', ns, e2 && e2.message)
      return false
    }
  }
}

// 批量失效。串行执行，数量极少（最多 2~3 个），不值得并发。
async function bumpVersions(namespaces) {
  const list = Array.isArray(namespaces) ? namespaces : [namespaces]
  const results = {}
  for (let i = 0; i < list.length; i++) {
    results[list[i]] = await bumpVersion(list[i])
  }
  return results
}

// 判断客户端缓存是否仍然有效（纯函数，可单测）。
// 严格相等而非 >=：防止客户端传一个超大版本号后永远拿不到新数据。
// 未传 / 非法 / <=0 一律返回 false —— 旧客户端不传 clientVersion 时必须拿到全量数据。
function isNotModified(clientVersion, currentVersion) {
  const cv = parseInt(clientVersion, 10)
  if (!Number.isFinite(cv) || cv <= 0) return false
  const sv = parseInt(currentVersion, 10)
  if (!Number.isFinite(sv) || sv <= 0) return false
  return cv === sv
}

module.exports = {
  CACHE_VERSION_COLL: COLL,
  CACHE_NAMESPACES,
  ALL_NAMESPACES,
  isValidNamespace,
  getVersion,
  getAllVersions,
  bumpVersion,
  bumpVersions,
  isNotModified
}

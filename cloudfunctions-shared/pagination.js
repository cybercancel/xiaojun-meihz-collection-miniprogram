// 共享分页与投影工具（TASK-420）
// 纯函数、无 wx-server-sdk 依赖，可被云函数与单元测试直接引用。
//
// 设计说明：
// - normalizePage：把 event.page / event.pageSize 规整为安全的 {page,pageSize,skip}，
//   强制上限 maxPageSize（防止超大分页拖垮数据库），默认 defaultPageSize。
// - buildListResult：根据分页参数与总数构造标准列表返回，附带 hasMore（稳定、可判断“是否还有下一页”）。
//   规范要求“总数或hasMore”二选一，这里两者都给，便于前端兼容。

/**
 * 规整分页参数
 * @param {object} event 云函数入参（含 page / pageSize）
 * @param {object} [opts]
 * @param {number} [opts.maxPageSize=50] 单页最大条数（硬上限）
 * @param {number} [opts.defaultPageSize=20] 未传时的默认每页条数
 * @param {number} [opts.minPageSize=1] 单页最小条数
 * @returns {{page:number,pageSize:number,skip:number}}
 */
function normalizePage(event, opts) {
  const o = opts || {}
  const maxPageSize = Number.isFinite(o.maxPageSize) ? o.maxPageSize : 50
  const defaultPageSize = Number.isFinite(o.defaultPageSize) ? o.defaultPageSize : 20
  const minPageSize = Number.isFinite(o.minPageSize) ? o.minPageSize : 1

  let page = parseInt((event && event.page), 10)
  if (!Number.isFinite(page) || page < 1) page = 1

  let pageSize = parseInt((event && event.pageSize), 10)
  if (!Number.isFinite(pageSize) || pageSize < minPageSize) pageSize = defaultPageSize
  if (pageSize > maxPageSize) pageSize = maxPageSize

  const skip = (page - 1) * pageSize
  return { page, pageSize, skip }
}

/**
 * 构造标准列表返回结构
 * @param {object} p
 * @param {Array} p.list 当前页数据
 * @param {number} p.total 总数
 * @param {number} p.page 当前页（来自 normalizePage）
 * @param {number} p.pageSize 每页条数（来自 normalizePage）
 * @returns {{list:Array,page:number,pageSize:number,total:number,hasMore:boolean}}
 */
function buildListResult(p) {
  const list = Array.isArray(p.list) ? p.list : []
  const total = Number.isFinite(p.total) ? p.total : 0
  const page = Number.isFinite(p.page) ? p.page : 1
  const pageSize = Number.isFinite(p.pageSize) ? p.pageSize : 20
  const hasMore = page * pageSize < total
  return { list, page, pageSize, total, hasMore }
}

/**
 * 投影辅助：返回带 .field() 的查询（include 或 exclude）。
 * @param {object} query db.collection(...).where(...) 之后的查询对象
 * @param {object} projection 形如 {field:true}（白名单）或 {field:false}（黑名单）
 * @returns {object} 链式返回 query（已 .field()）
 */
function applyProjection(query, projection) {
  if (!query || !projection || typeof query.field !== 'function') return query
  return query.field(projection)
}

module.exports = {
  normalizePage,
  buildListResult,
  applyProjection
}

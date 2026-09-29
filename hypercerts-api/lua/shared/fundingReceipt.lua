local RECEIPT = "org.hypercerts.funding.receipt"

local function receipt_query(sql, values)
  if db.backend() ~= "postgres" then
    error("ReceiptQueryFailed: the funding receipt API requires PostgreSQL", 0)
  end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("ReceiptQueryFailed: the funding receipt query or publisher hydration failed", 0)
  end
  return result
end

local function funding_receipt_view(row)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and NULL or row.indexed_at,
    did = row.did,
    author = { did = row.did },
    record = json.decode(row.record),
  }
end

local function hydrate_funding_receipt_views(views)
  local authors = {}
  for index, view in ipairs(views) do
    authors[index] = { did = view.did }
  end
  hydrate_actor_views(authors, receipt_query)
  for index, view in ipairs(views) do
    view.author = authors[index]
  end
end

local ATTACHMENT_COLLECTION = "org.hypercerts.context.attachment"

local function valid_attachment_uri(value)
  local valid, collection = valid_record_uri(value)
  return valid and collection == ATTACHMENT_COLLECTION
end

local function attachment_query(sql, values)
  local backend_ok, backend = pcall(db.backend)
  if not backend_ok or backend ~= "postgres" then
    error("AttachmentQueryFailed: attachment API requires PostgreSQL", 0)
  end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("AttachmentQueryFailed: attachment lookup failed", 0)
  end
  return result
end

local function attachment_view(row)
  local view = record_view(row)
  if row.indexed_at == nil then view.indexedAt = NULL end
  view.author = { did = row.did }
  return view
end

local function hydrate_attachment_views(views)
  local authors = {}
  for _, view in ipairs(views) do
    authors[#authors + 1] = view.author
  end
  hydrate_actor_views(authors, attachment_query)
end

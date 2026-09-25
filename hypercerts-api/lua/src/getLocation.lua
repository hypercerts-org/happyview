local function query_location(uri)
  if db.backend() ~= "postgres" then error("LocationQueryFailed: location API requires PostgreSQL", 0) end
  local rows = query("SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records WHERE collection = $1 AND uri = $2 LIMIT 1", { COLLECTION, uri })
  local views = {}
  for _, row in ipairs(rows) do views[#views + 1] = row_view(row) end
  hydrate(views)
  return views
end

local function get_location()
  keys_only(params, { uri = true })
  local uri = scalar(params, "uri")
  if not uri or not valid_uri(uri) then invalid("uri must be a full app.certified.location AT-URI with a DID authority") end
  local views = query_location(uri)
  if #views == 0 then error("RecordNotFound: location record is not indexed", 0) end
  return { location = views[1] }
end

function handle()
  return get_location()
end

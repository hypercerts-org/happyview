local COLLECTION = "app.certified.badge.definition"

local function valid_badge_definition_uri(value)
  local valid, collection = valid_record_uri(value)
  return valid and collection == COLLECTION
end

local function query(sql, values)
  local ok, result = pcall(db.raw, sql, values)
  if not ok then error("BadgeDefinitionQueryFailed: badge definition lookup failed", 0) end
  return result
end

local function get_badge_definition()
  keys_only(params, { uri = true })
  local uri = scalar(params, "uri")
  if not uri or not valid_badge_definition_uri(uri) then
    invalid("uri must be a full app.certified.badge.definition AT-URI with a DID authority")
  end
  if db.backend() ~= "postgres" then
    error("BadgeDefinitionQueryFailed: badge definition API requires PostgreSQL", 0)
  end
  local rows = query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND uri = $2 LIMIT 1",
    { COLLECTION, uri })
  if #rows == 0 then error("RecordNotFound: badge definition is not indexed", 0) end
  local view = record_view(rows[1])
  view.author = { did = view.did }
  hydrate_actor_views({ view.author }, query)
  return { badgeDefinition = view }
end

function handle()
  return get_badge_definition()
end

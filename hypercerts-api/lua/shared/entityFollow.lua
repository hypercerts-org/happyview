local ENTITY_FOLLOW = "app.certified.graph.entityFollow"
local ENTITY_FOLLOW_NULL = json.decode("null")

local function entity_follow_query(sql, values)
  if db.backend() ~= "postgres" then
    error("EntityFollowQueryFailed: entity-follow queries require PostgreSQL", 0)
  end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("EntityFollowQueryFailed: entity-follow lookup failed", 0)
  end
  return result
end

-- Keep malformed publisher timestamps out of casts; preserve the actor-follow fallback order.
local function entity_follow_sort_key()
  local created = "record::jsonb->>'createdAt'"
  local zoned = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$"
  return "CASE WHEN jsonb_typeof(record::jsonb->'createdAt') = 'string' AND " .. created .. " ~ '" .. zoned .. "' AND " .. created .. " !~ '-00:00$' AND pg_input_is_valid(" .. created .. ", 'timestamptz') THEN (" .. created .. ")::timestamptz ELSE COALESCE(indexed_at::timestamptz, created_at::timestamptz) END"
end

local function entity_follow_record_view(row)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and ENTITY_FOLLOW_NULL or row.indexed_at,
    did = row.did,
    record = json.decode(row.record),
  }
end

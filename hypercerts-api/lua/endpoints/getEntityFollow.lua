local function invalid(message)
  error("InvalidRequest: " .. message, 0)
end

local function keys_only(values, allowed)
  for key in pairs(values) do
    if not allowed[key] then invalid("unknown query parameter") end
  end
end

local function scalar(params, key)
  local value = params[key]
  if value == nil then return nil end
  if type(value) ~= "string" and type(value) ~= "number" then
    invalid(key .. " must occur once")
  end
  return tostring(value)
end

local function valid_did(value)
  if #value > 2048 then return false end
  local method, specific = value:match("^did:([a-z]+):(.+)$")
  if not method or not specific or specific:sub(-1) == ":" or specific:sub(-1) == "%"
    or value:find("[^%w%.:_%%%-]") then return false end
  return true
end

local function valid_record_key(value)
  return #value >= 1 and #value <= 512 and value ~= "." and value ~= ".."
    and not value:find("[^%w_~%.:%-]")
end

local function valid_record_uri(value)
  if type(value) ~= "string" or value:find("[?#]") then return false end
  local authority, collection, rkey = value:match("^at://([^/]+)/([^/]+)/([^/]+)$")
  if not authority or not valid_did(authority) or not valid_record_key(rkey) then return false end
  return true, collection
end

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

local function entity_follow_lookup(actor, entity_uri)
  local rows = entity_follow_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records CROSS JOIN LATERAL (SELECT " .. entity_follow_sort_key() .. " AS sort_at) sorted WHERE collection = $1 AND did = $2 AND record::jsonb->'subject'->>'uri' = $3 ORDER BY sorted.sort_at ASC, uri ASC LIMIT 1",
    { ENTITY_FOLLOW, actor, entity_uri })
  if #rows == 0 then return ENTITY_FOLLOW_NULL end
  return entity_follow_record_view(rows[1])
end

local function get_entity_follow()
  keys_only(params, { actor = true, entity = true })
  local actor = scalar(params, "actor")
  local entity_uri = scalar(params, "entity")
  if not actor or not valid_did(actor) then invalid("actor must be a valid DID") end
  if not entity_uri or #entity_uri > 8192 or not valid_record_uri(entity_uri) then
    invalid("entity must be a full DID-authority AT-URI")
  end
  return { follow = entity_follow_lookup(actor, entity_uri) }
end

function handle()
  return get_entity_follow()
end

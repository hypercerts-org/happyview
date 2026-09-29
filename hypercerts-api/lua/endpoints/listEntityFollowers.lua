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

local function valid_datetime(value)
  local year, month, day, hour, minute, second, suffix = value:match(
    "^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)(.*)$")
  if not year then return false end
  year, month, day = tonumber(year), tonumber(month), tonumber(day)
  hour, minute, second = tonumber(hour), tonumber(minute), tonumber(second)
  if month < 1 or month > 12 or hour > 23 or minute > 59 or second > 59 then return false end
  local leap = year % 4 == 0 and (year % 100 ~= 0 or year % 400 == 0)
  local month_days = { 31, leap and 29 or 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
  if day < 1 or day > month_days[month] then return false end
  local fraction, zone = suffix:match("^(%.%d+)(Z)$")
  if not fraction then fraction, zone = suffix:match("^(%.%d+)([+-]%d%d:%d%d)$") end
  if not fraction then zone = suffix:match("^(Z)$") end
  if not zone then zone = suffix:match("^([+-]%d%d:%d%d)$") end
  if not zone or zone == "-00:00" then return false end
  if zone ~= "Z" then
    local zh, zm = zone:match("^[+-](%d%d):(%d%d)$")
    if not zh or tonumber(zh) > 23 or tonumber(zm) > 59 then return false end
  end
  return true
end

local function parse_list_limit(params)
  local limit_value = scalar(params, "limit")
  if limit_value and not limit_value:match("^%d+$") then invalid("limit must be an integer from 1 through 100") end
  local limit = limit_value and tonumber(limit_value) or 25
  if not limit or limit % 1 ~= 0 or limit < 1 or limit > 100 then invalid("limit must be an integer from 1 through 100") end
  return limit
end

local function parse_sort_direction(params)
  local direction = scalar(params, "sortDirection") or "desc"
  if direction ~= "asc" and direction ~= "desc" then invalid("sortDirection must be 'asc' or 'desc'") end
  return direction
end

local function cursor_encode(value)
  local encoded = json.encode(value)
  return (encoded:gsub(".", function(char) return string.format("%02x", string.byte(char)) end))
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

local function entity_follow_decode_cursor(token, direction)
  if token == nil then return nil end
  if #token == 0 or #token > 8192 or #token % 2 ~= 0 or token:find("[^0-9a-f]") then
    invalid("cursor is malformed")
  end
  local decoded = token:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end)
  local ok, value = pcall(json.decode, decoded)
  if not ok or type(value) ~= "table" or value.v ~= 1 or value.d ~= direction
    or type(value.t) ~= "string" or type(value.u) ~= "string" then
    invalid("cursor is malformed or belongs to another sortDirection")
  end
  for key in pairs(value) do
    if key ~= "v" and key ~= "d" and key ~= "t" and key ~= "u" then invalid("cursor is malformed") end
  end
  local valid, collection = valid_record_uri(value.u)
  if not valid or collection ~= ENTITY_FOLLOW or not valid_datetime(value.t) then
    invalid("cursor is malformed")
  end
  return value
end

local function entity_follow_query_page(mode, identity, limit, cursor, direction)
  local filters, values = { "collection = $1" }, { ENTITY_FOLLOW, identity }
  if mode == "followers" then
    filters[#filters + 1] = "record::jsonb->'subject'->>'uri' = $2"
  else
    filters[#filters + 1] = "did = $2"
  end

  local cursor_filter = ""
  if cursor then
    values[#values + 1] = cursor.t
    local timestamp = "$" .. #values .. "::timestamptz"
    values[#values + 1] = cursor.u
    local uri = "$" .. #values
    local operator = direction == "asc" and ">" or "<"
    cursor_filter = " WHERE (sort_at, uri) " .. operator .. " (" .. timestamp .. ", " .. uri .. ")"
  end

  values[#values + 1] = limit + 1
  local ordering = direction == "asc" and "ASC" or "DESC"
  local subject_uri = "record::jsonb->'subject'->>'uri'"
  local sql = "WITH ranked_follows AS (SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record, sorted.sort_at, ROW_NUMBER() OVER (PARTITION BY did, " .. subject_uri .. " ORDER BY sorted.sort_at ASC, uri ASC) AS relationship_rank FROM happyview_records CROSS JOIN LATERAL (SELECT " .. entity_follow_sort_key() .. " AS sort_at) sorted WHERE " .. table.concat(filters, " AND ") .. "), " ..
    "representatives AS (SELECT uri, did, cid, indexed_at, record, sort_at FROM ranked_follows WHERE relationship_rank = 1), " ..
    "page AS (SELECT uri, did, cid, indexed_at, record, sort_at FROM representatives" .. cursor_filter .. " ORDER BY sort_at " .. ordering .. ", uri " .. ordering .. " LIMIT $" .. #values .. ") " ..
    "SELECT page.uri, page.did, page.cid, page.indexed_at, page.record, to_char(page.sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS sort_timestamp FROM page ORDER BY page.sort_at " .. ordering .. ", page.uri " .. ordering
  local rows = entity_follow_query(sql, values)
  local more = #rows > limit
  if more then rows[#rows] = nil end

  local next_cursor
  if more then
    local last = rows[#rows]
    if not last or type(last.sort_timestamp) ~= "string" or type(last.uri) ~= "string" then
      error("EntityFollowQueryFailed: next-page cursor fields unavailable", 0)
    end
    next_cursor = cursor_encode({ v = 1, d = direction, t = last.sort_timestamp, u = last.uri })
  end
  return rows, next_cursor
end

local ENTITY_FOLLOW_FOLLOWER_PROFILE = "app.certified.actor.profile"
local ENTITY_FOLLOW_FOLLOWER_ORGANIZATION = "app.certified.actor.organization"

local function entity_follow_load_actor_records(collection, dids)
  if #dids == 0 then return {} end
  local values, placeholders = { collection }, {}
  for _, did in ipairs(dids) do
    values[#values + 1] = did
    placeholders[#placeholders + 1] = "$" .. #values
  end
  local rows = entity_follow_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN (" .. table.concat(placeholders, ", ") .. ")",
    values)
  local by_did = {}
  for _, row in ipairs(rows) do by_did[row.did] = row end
  return by_did
end

local function entity_follow_hydrate_followers(followers)
  if #followers == 0 then return end
  local dids, seen = {}, {}
  for _, follower in ipairs(followers) do
    if not seen[follower.did] then
      seen[follower.did] = true
      dids[#dids + 1] = follower.did
    end
  end
  local profiles = entity_follow_load_actor_records(ENTITY_FOLLOW_FOLLOWER_PROFILE, dids)
  local organizations = entity_follow_load_actor_records(ENTITY_FOLLOW_FOLLOWER_ORGANIZATION, dids)
  for _, follower in ipairs(followers) do
    follower.profile = profiles[follower.did] and entity_follow_record_view(profiles[follower.did]) or ENTITY_FOLLOW_NULL
    follower.organization = organizations[follower.did] and entity_follow_record_view(organizations[follower.did]) or ENTITY_FOLLOW_NULL
  end
end

local function entity_follow_follower_views(rows)
  local followers = {}
  for _, row in ipairs(rows) do
    followers[#followers + 1] = { did = row.did, follow = entity_follow_record_view(row) }
  end
  entity_follow_hydrate_followers(followers)
  return followers
end

local function list_entity_followers()
  keys_only(params, { entity = true, sortDirection = true, limit = true, cursor = true })
  local entity_uri = scalar(params, "entity")
  if not entity_uri or #entity_uri > 8192 or not valid_record_uri(entity_uri) then
    invalid("entity must be a full DID-authority AT-URI")
  end

  local limit = parse_list_limit(params)
  local direction = parse_sort_direction(params)
  local cursor = entity_follow_decode_cursor(scalar(params, "cursor"), direction)
  local rows, next_cursor = entity_follow_query_page("followers", entity_uri, limit, cursor, direction)
  local response = { followers = toarray(entity_follow_follower_views(rows)) }
  if next_cursor then response.cursor = next_cursor end
  return response
end

function handle()
  return list_entity_followers()
end

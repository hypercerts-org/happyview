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

local ACCOUNT_FOLLOW = "app.certified.graph.follow"
local ENTITY_FOLLOW = "app.certified.graph.entityFollow"
local NULL = json.decode("null")

local function recent_valid_record_key(value)
  return #value >= 1 and #value <= 512 and value ~= "." and value ~= ".."
    and not value:find("[^%w_~%.:%-]")
end

local function recent_valid_record_uri(value)
  if type(value) ~= "string" or value:find("[?#]") then return false end
  local authority, collection, rkey = value:match("^at://([^/]+)/([^/]+)/([^/]+)$")
  if not authority or not valid_did(authority) or not recent_valid_record_key(rkey) then return false end
  return collection == ACCOUNT_FOLLOW or collection == ENTITY_FOLLOW
end

local function recent_valid_datetime(value)
  if type(value) ~= "string" then return false end
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

local function recent_parse_limit(request_params)
  local value = scalar(request_params, "limit")
  if value and not value:match("^%d+$") then invalid("limit must be an integer from 1 through 100") end
  local limit = value and tonumber(value) or 25
  if not limit or limit % 1 ~= 0 or limit < 1 or limit > 100 then
    invalid("limit must be an integer from 1 through 100")
  end
  return limit
end

local function recent_cursor_encode(value)
  local encoded = json.encode(value)
  return (encoded:gsub(".", function(char) return string.format("%02x", string.byte(char)) end))
end

local function recent_cursor_decode(token, before)
  if not token then return nil end
  if #token % 2 ~= 0 or token:find("[^0-9a-f]") then invalid("cursor is malformed") end
  local decoded = token:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end)
  local ok, value = pcall(json.decode, decoded)
  if not ok or type(value) ~= "table" or value.v ~= 1
    or type(value.t) ~= "string" or type(value.u) ~= "string"
    or (type(value.b) ~= "string" and value.b ~= false) then
    invalid("cursor is malformed")
  end
  for key in pairs(value) do
    if key ~= "v" and key ~= "t" and key ~= "u" and key ~= "b" then invalid("cursor is malformed") end
  end
  if not recent_valid_datetime(value.t) or not recent_valid_record_uri(value.u)
    or value.b ~= (before or false) then
    invalid("cursor is malformed or belongs to another before value")
  end
  return value
end

local function recent_created_at_sort_key()
  local created = "record::jsonb->>'createdAt'"
  local zoned = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$"
  return "CASE WHEN jsonb_typeof(record::jsonb->'createdAt') = 'string' AND " .. created .. " ~ '" .. zoned .. "' AND " .. created .. " !~ '-00:00$' AND pg_input_is_valid(" .. created .. ", 'timestamptz') THEN (" .. created .. ")::timestamptz END"
end

local function recent_query(sql, values)
  if db.backend() ~= "postgres" then
    error("RecentFollowsQueryFailed: recent-follows queries require PostgreSQL", 0)
  end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("RecentFollowsQueryFailed: recent-follows lookup failed", 0)
  end
  return result
end

local function recent_record_view(row)
  local ok, record = pcall(json.decode, row.record)
  if not ok then error("RecentFollowsQueryFailed: indexed follow record could not be decoded", 0) end
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at or NULL,
    did = row.did,
    record = record,
  }
end

local function recent_follows_response()
  local request_params = params or {}
  keys_only(request_params, { before = true, cursor = true, limit = true })

  local before = scalar(request_params, "before")
  if before and not recent_valid_datetime(before) then
    invalid("before must be a valid datetime")
  end
  local limit = recent_parse_limit(request_params)
  local cursor = recent_cursor_decode(scalar(request_params, "cursor"), before)

  local predicates = { "sort_at IS NOT NULL" }
  local values = { ACCOUNT_FOLLOW, ENTITY_FOLLOW }
  if before then
    values[#values + 1] = before
    predicates[#predicates + 1] = "sort_at < $" .. #values .. "::timestamptz"
  end
  if cursor then
    values[#values + 1] = cursor.t
    local timestamp = "$" .. #values .. "::timestamptz"
    values[#values + 1] = cursor.u
    local uri = "$" .. #values
    predicates[#predicates + 1] = "(sort_at, uri) < (" .. timestamp .. ", " .. uri .. ")"
  end
  values[#values + 1] = limit + 1

  local sql = "WITH candidates AS (SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record, sorted.sort_at " ..
    "FROM happyview_records CROSS JOIN LATERAL (SELECT " .. recent_created_at_sort_key() .. " AS sort_at) AS sorted " ..
    "WHERE collection IN ($1, $2) AND cid <> ''), page AS (SELECT uri, did, cid, indexed_at, record, sort_at FROM candidates WHERE " ..
    table.concat(predicates, " AND ") .. " ORDER BY sort_at DESC, uri DESC LIMIT $" .. #values .. ") " ..
    "SELECT uri, did, cid, indexed_at, record, to_char(sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS sort_timestamp " ..
    "FROM page ORDER BY sort_at DESC, uri DESC"
  local rows = recent_query(sql, values)
  local has_more = #rows > limit
  if has_more then rows[#rows] = nil end

  local follows = {}
  for _, row in ipairs(rows) do
    follows[#follows + 1] = recent_record_view(row)
  end
  local response = { follows = toarray(follows) }
  if has_more then
    local last = rows[#rows]
    response.cursor = recent_cursor_encode({ v = 1, t = last.sort_timestamp, u = last.uri, b = before or false })
  end
  return response
end

function handle()
  return recent_follows_response()
end

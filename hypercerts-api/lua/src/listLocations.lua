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

local function array(params, key, validate, description, max_bytes)
  local value = params[key]
  if value == nil then return nil end
  local values = {}
  if type(value) == "string" then values[1] = value
  elseif type(value) == "table" then
    for i = 1, #value do
      if type(value[i]) ~= "string" then invalid(key .. " entries must be strings") end
      values[#values + 1] = value[i]
    end
  else invalid(key .. " must be a string or repeated string parameter") end
  if #values > 100 then invalid(key .. " accepts at most 100 values") end
  local unique, seen = {}, {}
  for _, item in ipairs(values) do
    if max_bytes and #item > max_bytes then invalid(key .. " entries must be at most " .. max_bytes .. " UTF-8 bytes") end
    if validate and not validate(item) then invalid("each " .. key .. " value must be " .. description) end
    if not seen[item] then seen[item] = true; unique[#unique + 1] = item end
  end
  return unique
end

local function add_in(where, params, column, values)
  if not values then return end
  if #values == 0 then where[#where + 1] = "FALSE"; return end
  local placeholders = {}
  for _, value in ipairs(values) do
    params[#params + 1] = value
    placeholders[#placeholders + 1] = "$" .. #params
  end
  where[#where + 1] = column .. " IN (" .. table.concat(placeholders, ",") .. ")"
end

local function cursor_encode(value)
  local encoded = json.encode(value)
  return (encoded:gsub(".", function(char) return string.format("%02x", string.byte(char)) end))
end

local function cursor_decode(token, direction)
  if not token then return nil end
  if #token % 2 ~= 0 or token:find("[^0-9a-f]") then invalid("cursor is malformed") end
  local decoded = token:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end)
  local ok, value = pcall(json.decode, decoded)
  if not ok or type(value) ~= "table" or value.v ~= 1 or value.d ~= direction
    or type(value.t) ~= "string" or type(value.u) ~= "string" then
    invalid("cursor is malformed or belongs to another sortDirection")
  end
  for key in pairs(value) do
    if key ~= "v" and key ~= "d" and key ~= "t" and key ~= "u" then invalid("cursor is malformed") end
  end
  if not valid_uri(value.u) or not valid_datetime(value.t) then invalid("cursor is malformed") end
  return value
end

local function query_locations(filters, limit, cursor, direction)
  if db.backend() ~= "postgres" then error("LocationQueryFailed: location API requires PostgreSQL", 0) end
  local where, binds = { "collection = $1" }, { COLLECTION }
  add_in(where, binds, "did", filters.authors)
  add_in(where, binds, "uri", filters.uris)
  add_in(where, binds, "(record::jsonb)->>'locationType'", filters.locationTypes)
  if cursor then
    binds[#binds + 1] = cursor.t
    local time = "$" .. #binds
    binds[#binds + 1] = cursor.u
    local uri = "$" .. #binds
    local op = direction == "asc" and ">" or "<"
    where[#where + 1] = "(sorted.sort_at, uri) " .. op .. " ((" .. time .. ")::timestamptz, " .. uri .. ")"
  end
  binds[#binds + 1] = limit + 1
  local ordering = direction == "asc" and "ASC" or "DESC"
  -- CASE guards the cast itself; a WHERE regex cannot protect it from planner reordering.
  local created = "record::jsonb->>'createdAt'"
  local zoned = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$"
  local sort_key = "CASE WHEN jsonb_typeof(record::jsonb->'createdAt') = 'string' AND " .. created .. " ~ '" .. zoned .. "' AND " .. created .. " !~ '-00:00$' AND pg_input_is_valid(" .. created .. ", 'timestamptz') THEN (" .. created .. ")::timestamptz ELSE COALESCE(indexed_at::timestamptz, created_at::timestamptz) END"
  local sql = "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record, to_char(sorted.sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS sort_timestamp FROM happyview_records CROSS JOIN LATERAL (SELECT " .. sort_key .. " AS sort_at) sorted WHERE " .. table.concat(where, " AND ") .. " ORDER BY sorted.sort_at " .. ordering .. ", uri " .. ordering .. " LIMIT $" .. #binds
  local rows = query(sql, binds)
  local more = #rows > limit
  if more then rows[#rows] = nil end
  local views = {}
  for _, row in ipairs(rows) do views[#views + 1] = row_view(row) end
  hydrate(views)
  local next_cursor
  if more then
    local last = rows[#rows]
    next_cursor = cursor_encode({ v = 1, d = direction, t = last.sort_timestamp, u = last.uri })
  end
  return views, next_cursor
end

local function list_locations()
  keys_only(params, { authors = true, uris = true, locationTypes = true, limit = true, cursor = true, sortDirection = true })
  local authors = array(params, "authors", valid_did, "valid DIDs")
  local uris = array(params, "uris", valid_uri, "full app.certified.location AT-URIs with DID authorities")
  local types = array(params, "locationTypes", nil, nil, 20)
  local limit_value = scalar(params, "limit")
  if limit_value and not limit_value:match("^%d+$") then invalid("limit must be an integer from 1 through 100") end
  local limit = limit_value and tonumber(limit_value) or 25
  if not limit or limit % 1 ~= 0 or limit < 1 or limit > 100 then invalid("limit must be an integer from 1 through 100") end
  local direction = scalar(params, "sortDirection") or "desc"
  if direction ~= "asc" and direction ~= "desc" then invalid("sortDirection must be 'asc' or 'desc'") end
  local cursor = cursor_decode(scalar(params, "cursor"), direction)
  local views, next_cursor = query_locations({ authors = authors, uris = uris, locationTypes = types }, limit, cursor, direction)
  local response = { locations = toarray(views) }
  if next_cursor then response.cursor = next_cursor end
  return response
end

function handle()
  return list_locations()
end

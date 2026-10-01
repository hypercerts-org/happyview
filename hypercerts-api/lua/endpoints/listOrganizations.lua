local PROFILE = "app.certified.actor.profile"
local ORGANIZATION = "app.certified.actor.organization"
local NULL = json.decode("null")

local function invalid(message)
  error("InvalidRequest: " .. message, 0)
end

local function keys_only(values, allowed)
  for key in pairs(values) do
    if not allowed[key] then invalid("unknown query parameter") end
  end
end

local function scalar(values, key)
  local value = values[key]
  if value == nil then return nil end
  if type(value) ~= "string" and type(value) ~= "number" then
    invalid(key .. " must occur once")
  end
  return tostring(value)
end

local function valid_did(value)
  if type(value) ~= "string" or #value > 2048 then return false end
  local method, specific = value:match("^did:([a-z]+):(.+)$")
  if not method or not specific or specific:sub(-1) == ":" or specific:sub(-1) == "%"
    or value:find("[^%w%.:_%%%-]") then return false end
  return true
end

local function query(sql, values)
  if db.backend() ~= "postgres" then error("OrganizationQueryFailed: organization API requires PostgreSQL", 0) end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("OrganizationQueryFailed: organization lookup failed", 0)
  end
  return result
end

local function record_view(row)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at,
    did = row.did,
    record = json.decode(row.record),
  }
end

local function organization_actor_view(row)
  return {
    did = row.did,
    profile = NULL,
    organization = record_view(row),
  }
end

local function hydrate_organization_actors(actors)
  if #actors == 0 then return end

  local dids, seen = {}, {}
  for _, actor in ipairs(actors) do
    if not seen[actor.did] then
      seen[actor.did] = true
      dids[#dids + 1] = actor.did
    end
  end

  local values, marks = { PROFILE }, {}
  for _, did in ipairs(dids) do
    values[#values + 1] = did
    marks[#marks + 1] = "$" .. #values
  end
  local rows = query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN (" .. table.concat(marks, ", ") .. ")",
    values)
  local profiles = {}
  for _, row in ipairs(rows) do profiles[row.did] = row end
  for _, actor in ipairs(actors) do
    actor.profile = profiles[actor.did] and record_view(profiles[actor.did]) or NULL
  end
end

local function valid_datetime(value)
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

local function valid_organization_uri(value)
  if type(value) ~= "string" or value:find("[?#]") then return false end
  local authority, collection, rkey = value:match("^at://([^/]+)/([^/]+)/([^/]+)$")
  return authority ~= nil and valid_did(authority) and collection == ORGANIZATION and rkey == "self"
end

local function array(params, key)
  local value = params[key]
  if value == nil then return nil end
  local values, occurrences = {}, 0
  if type(value) == "string" then
    values[1] = value
  elseif type(value) == "table" then
    for index in pairs(value) do
      if type(index) ~= "number" or index < 1 or index % 1 ~= 0 then
        invalid(key .. " must use repeated query values")
      end
      occurrences = occurrences + 1
    end
    if occurrences ~= #value then invalid(key .. " must use repeated query values") end
    for index = 1, occurrences do
      if type(value[index]) ~= "string" then invalid(key .. " entries must be strings") end
      values[#values + 1] = value[index]
    end
  else
    invalid(key .. " must be a string or repeated string parameter")
  end
  if #values > 100 then invalid(key .. " accepts at most 100 values") end

  local unique, seen = {}, {}
  for _, item in ipairs(values) do
    if key == "actors" and not valid_did(item) then invalid("each actors value must be a valid DID") end
    if key == "organizationTypes" and #item > 128 then
      invalid("each organizationTypes value must be at most 128 characters")
    end
    if not seen[item] then
      seen[item] = true
      unique[#unique + 1] = item
    end
  end
  return unique
end

local function add_actors(where, values, actors)
  if not actors then return end
  if #actors == 0 then where[#where + 1] = "FALSE"; return end
  local placeholders = {}
  for _, did in ipairs(actors) do
    values[#values + 1] = did
    placeholders[#placeholders + 1] = "$" .. #values
  end
  where[#where + 1] = "organization.did IN (" .. table.concat(placeholders, ", ") .. ")"
end

local function add_organization_types(where, values, organization_types)
  if not organization_types then return end
  if #organization_types == 0 then where[#where + 1] = "FALSE"; return end
  local placeholders = {}
  for _, organization_type in ipairs(organization_types) do
    values[#values + 1] = organization_type
    placeholders[#placeholders + 1] = "$" .. #values
  end
  local array_value = "CASE WHEN jsonb_typeof(organization.record::jsonb->'organizationType') = 'array' " ..
    "THEN organization.record::jsonb->'organizationType' ELSE '[]'::jsonb END"
  where[#where + 1] = "EXISTS (SELECT 1 FROM jsonb_array_elements_text(" .. array_value ..
    ") AS organization_type(value) WHERE organization_type.value IN (" .. table.concat(placeholders, ", ") .. "))"
end

local function cursor_encode(value)
  return (json.encode(value):gsub(".", function(char)
    return string.format("%02x", string.byte(char))
  end))
end

local function cursor_decode(token, direction)
  if token == nil then return nil end
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
  if not valid_organization_uri(value.u) or not valid_datetime(value.t) then invalid("cursor is malformed") end
  return value
end

local function query_organizations(actors, organization_types, visibility, search, limit, cursor, direction)
  local where, values = { "organization.collection = $1", "organization.rkey = 'self'" }, { ORGANIZATION }
  add_actors(where, values, actors)
  add_organization_types(where, values, organization_types)
  if visibility ~= nil then
    values[#values + 1] = visibility
    where[#where + 1] = "organization.record::jsonb->>'visibility' = $" .. #values
  end
  if search then
    values[#values + 1] = search
    local search_parameter = "$" .. #values
    values[#values + 1] = PROFILE
    local profile_collection = "$" .. #values
    where[#where + 1] = "EXISTS (SELECT 1 FROM happyview_records AS profile " ..
      "WHERE profile.collection = " .. profile_collection .. " AND profile.did = organization.did " ..
      "AND profile.rkey = 'self' AND (strpos(lower(COALESCE(profile.record::jsonb->>'displayName', '')), lower(" ..
      search_parameter .. ")) > 0 OR strpos(lower(COALESCE(profile.record::jsonb->>'description', '')), lower(" ..
      search_parameter .. ")) > 0))"
  end
  if cursor then
    values[#values + 1] = cursor.t
    local timestamp = "$" .. #values
    values[#values + 1] = cursor.u
    local uri = "$" .. #values
    local operator = direction == "asc" and ">" or "<"
    where[#where + 1] = "(sorted.sort_at, uri) " .. operator .. " ((" .. timestamp .. ")::timestamptz, " .. uri .. ")"
  end

  values[#values + 1] = limit + 1
  local ordering = direction == "asc" and "ASC" or "DESC"
  local created = "organization.record::jsonb->>'createdAt'"
  local zoned = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$"
  local sort_key = "CASE WHEN jsonb_typeof(organization.record::jsonb->'createdAt') = 'string' AND " .. created .. " ~ '" .. zoned ..
    "' AND " .. created .. " !~ '-00:00$' AND pg_input_is_valid(" .. created .. ", 'timestamptz') THEN (" .. created ..
    ")::timestamptz ELSE COALESCE(organization.indexed_at::timestamptz, organization.created_at::timestamptz) END"
  local sql = "SELECT organization.uri, organization.did, organization.cid, organization.indexed_at::text AS indexed_at, " ..
    "organization.record::text AS record, to_char(sorted.sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS sort_timestamp " ..
    "FROM happyview_records AS organization CROSS JOIN LATERAL (SELECT " .. sort_key .. " AS sort_at) AS sorted WHERE " ..
    table.concat(where, " AND ") .. " ORDER BY sorted.sort_at " .. ordering .. ", uri " .. ordering .. " LIMIT $" .. #values
  local rows = query(sql, values)
  local more = #rows > limit
  if more then rows[#rows] = nil end

  local actors_result = {}
  for _, row in ipairs(rows) do
    actors_result[#actors_result + 1] = organization_actor_view(row)
  end
  local next_cursor
  if more then
    local last = rows[#rows]
    next_cursor = cursor_encode({ v = 1, d = direction, t = last.sort_timestamp, u = last.uri })
  end
  hydrate_organization_actors(actors_result)
  return actors_result, next_cursor
end

local function organizations_response(search_enabled)
  local allowed = {
    actors = true,
    organizationTypes = true,
    visibility = true,
    sortDirection = true,
    limit = true,
    cursor = true,
  }
  if search_enabled then allowed.search = true end
  keys_only(params, allowed)

  local actors = array(params, "actors")
  local organization_types = array(params, "organizationTypes")
  local visibility = scalar(params, "visibility")
  local search
  if search_enabled then
    search = scalar(params, "search")
    if search == nil then invalid("search is required") end
    search = search:match("^%s*(.-)%s*$")
    if search == "" then search = nil end
  end

  local limit_value = scalar(params, "limit")
  if limit_value and not limit_value:match("^%d+$") then invalid("limit must be an integer from 1 through 100") end
  local limit = limit_value and tonumber(limit_value) or 25
  if not limit or limit % 1 ~= 0 or limit < 1 or limit > 100 then
    invalid("limit must be an integer from 1 through 100")
  end

  local direction = scalar(params, "sortDirection") or "desc"
  if direction ~= "asc" and direction ~= "desc" then invalid("sortDirection must be 'asc' or 'desc'") end
  local cursor = cursor_decode(scalar(params, "cursor"), direction)
  local actors_result, next_cursor = query_organizations(actors, organization_types, visibility, search, limit, cursor, direction)
  local response = { actors = toarray(actors_result) }
  if next_cursor then response.cursor = next_cursor end
  return response
end

function handle()
  return organizations_response(false)
end

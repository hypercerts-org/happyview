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

local NULL = json.decode("null")

local function record_view(row)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at,
    did = row.did,
    record = json.decode(row.record),
  }
end

local PROFILE = "app.certified.actor.profile"
local ORGANIZATION = "app.certified.actor.organization"

local function hydrate_actor_views(actors, run_query)
  if #actors == 0 then return end
  local dids, seen = {}, {}
  for _, actor in ipairs(actors) do
    if not seen[actor.did] then
      seen[actor.did] = true
      dids[#dids + 1] = actor.did
    end
  end
  local profiles, organizations = {}, {}
  local function load(collection, target)
    local params, marks = { collection }, {}
    for _, did in ipairs(dids) do
      params[#params + 1] = did
      marks[#marks + 1] = "$" .. #params
    end
    local rows = run_query("SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN (" .. table.concat(marks, ",") .. ")", params)
    for _, row in ipairs(rows) do target[row.did] = row end
  end
  load(PROFILE, profiles)
  load(ORGANIZATION, organizations)
  for _, actor in ipairs(actors) do
    actor.profile = profiles[actor.did] and record_view(profiles[actor.did]) or NULL
    actor.organization = organizations[actor.did] and record_view(organizations[actor.did]) or NULL
  end
end

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

local function attachment_array(params, key, validate, description)
  local value = params[key]
  if value == nil then return nil end
  local supplied = {}
  if type(value) == "string" then
    supplied[1] = value
  elseif type(value) == "table" then
    local count = 0
    for index in pairs(value) do
      if type(index) ~= "number" or index < 1 or index % 1 ~= 0 then
        invalid(key .. " must use repeated query values")
      end
      count = count + 1
    end
    if count ~= #value then invalid(key .. " must use repeated query values") end
    for index = 1, count do
      if type(value[index]) ~= "string" then invalid(key .. " entries must be strings") end
      supplied[#supplied + 1] = value[index]
    end
  else
    invalid(key .. " must be a string or repeated string parameter")
  end
  if #supplied > 100 then invalid(key .. " accepts at most 100 values") end

  local unique, seen = {}, {}
  for _, item in ipairs(supplied) do
    if validate and not validate(item) then invalid("each " .. key .. " value must be " .. description) end
    if not seen[item] then
      seen[item] = true
      unique[#unique + 1] = item
    end
  end
  return unique
end

local function attachment_bind_in(where, values, expression, items)
  if not items then return end
  if #items == 0 then
    where[#where + 1] = "FALSE"
    return
  end
  local placeholders = {}
  for _, item in ipairs(items) do
    values[#values + 1] = item
    placeholders[#placeholders + 1] = "$" .. #values
  end
  where[#where + 1] = expression .. " IN (" .. table.concat(placeholders, ", ") .. ")"
end

local function attachment_subject_filter(where, values, subjects)
  if not subjects then return end
  if #subjects == 0 then
    where[#where + 1] = "FALSE"
    return
  end
  local placeholders = {}
  for _, subject in ipairs(subjects) do
    values[#values + 1] = subject
    placeholders[#placeholders + 1] = "$" .. #values
  end
  where[#where + 1] = "EXISTS (SELECT 1 FROM jsonb_array_elements(" ..
    "CASE WHEN jsonb_typeof(attachment.record::jsonb->'subjects') = 'array' " ..
    "THEN attachment.record::jsonb->'subjects' ELSE '[]'::jsonb END) AS subject(value) " ..
    "WHERE subject.value->>'uri' IN (" .. table.concat(placeholders, ", ") .. "))"
end

local function attachment_sort_expression()
  local created = "attachment.record::jsonb->>'createdAt'"
  local zoned = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$"
  return "CASE WHEN jsonb_typeof(attachment.record::jsonb->'createdAt') = 'string' AND " .. created ..
    " ~ '" .. zoned .. "' AND " .. created .. " !~ '-00:00$' AND pg_input_is_valid(" .. created ..
    ", 'timestamptz') THEN (" .. created .. ")::timestamptz ELSE " ..
    "COALESCE(attachment.indexed_at::timestamptz, attachment.created_at::timestamptz) END"
end

local function attachment_cursor_decode(token, direction)
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
  if not valid_datetime(value.t) or not valid_attachment_uri(value.u) then invalid("cursor is malformed") end
  return value
end

local function query_attachments(filters, limit, cursor, direction)
  local where, values = { "attachment.collection = $1" }, { ATTACHMENT_COLLECTION }
  attachment_bind_in(where, values, "attachment.did", filters.authors)
  attachment_bind_in(where, values, "attachment.uri", filters.uris)
  attachment_subject_filter(where, values, filters.subjects)
  attachment_bind_in(where, values, "attachment.record::jsonb->>'contentType'", filters.content_types)

  if cursor then
    values[#values + 1] = cursor.t
    local timestamp = "$" .. #values
    values[#values + 1] = cursor.u
    local uri = "$" .. #values
    local operator = direction == "asc" and ">" or "<"
    where[#where + 1] = "(sorted.sort_at, attachment.uri) " .. operator ..
      " ((" .. timestamp .. ")::timestamptz, " .. uri .. ")"
  end

  values[#values + 1] = limit + 1
  local ordering = direction == "asc" and "ASC" or "DESC"
  local sort_key = attachment_sort_expression()
  local sql = "SELECT attachment.uri, attachment.did, attachment.cid, attachment.indexed_at::text AS indexed_at, " ..
    "attachment.record::text AS record, to_char(sorted.sort_at AT TIME ZONE 'UTC', " ..
    "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS sort_timestamp " ..
    "FROM happyview_records AS attachment CROSS JOIN LATERAL (SELECT " .. sort_key .. " AS sort_at) AS sorted " ..
    "WHERE " .. table.concat(where, " AND ") .. " ORDER BY sorted.sort_at " .. ordering ..
    ", attachment.uri " .. ordering .. " LIMIT $" .. #values
  local rows = attachment_query(sql, values)
  local more = #rows > limit
  if more then rows[#rows] = nil end

  local views = {}
  for _, row in ipairs(rows) do views[#views + 1] = attachment_view(row) end
  hydrate_attachment_views(views)

  local next_cursor
  if more then
    local last = rows[#rows]
    next_cursor = cursor_encode({ v = 1, d = direction, t = last.sort_timestamp, u = last.uri })
  end
  return views, next_cursor
end

local function list_attachments()
  keys_only(params, {
    authors = true,
    uris = true,
    subjects = true,
    contentTypes = true,
    sortDirection = true,
    limit = true,
    cursor = true,
  })
  local authors = attachment_array(params, "authors", valid_did, "valid DIDs")
  local uris = attachment_array(params, "uris", valid_attachment_uri,
    "full org.hypercerts.context.attachment AT-URIs with DID authorities")
  local subjects = attachment_array(params, "subjects", function(value)
    return valid_record_uri(value)
  end, "full AT-URIs with DID authorities")
  local content_types = attachment_array(params, "contentTypes")
  local limit = parse_list_limit(params)
  local direction = parse_sort_direction(params)
  local cursor = attachment_cursor_decode(scalar(params, "cursor"), direction)
  local attachments, next_cursor = query_attachments({
    authors = authors,
    uris = uris,
    subjects = subjects,
    content_types = content_types,
  }, limit, cursor, direction)
  local response = { attachments = toarray(attachments) }
  if next_cursor then response.cursor = next_cursor end
  return response
end

function handle()
  return list_attachments()
end

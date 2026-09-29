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

local EVALUATION = "org.hypercerts.context.evaluation"
local EVALUATOR_HYDRATION_LIMIT = 100

local function evaluation_query(sql, values)
  if db.backend() ~= "postgres" then
    error("EvaluationQueryFailed: evaluation API requires PostgreSQL", 0)
  end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("EvaluationQueryFailed: evaluation lookup failed", 0)
  end
  return result
end

local function evaluation_view(row)
  local view = record_view(row)
  if type(view.record) ~= "table" or type(view.record.evaluators) ~= "table" then
    error("EvaluationQueryFailed: indexed evaluation has no evaluator array", 0)
  end
  if #view.record.evaluators > 1000 then
    error("EvaluationQueryFailed: indexed evaluation exceeds the evaluator limit", 0)
  end
  view.author = { did = row.did }
  return view
end

local function hydrate_evaluation_views(views)
  local actors = {}
  local evaluator_projections = {}
  local evaluator_actors = {}

  for view_index, view in ipairs(views) do
    actors[#actors + 1] = view.author
    local projections, hydrated_actors = {}, {}
    for position, source in ipairs(view.record.evaluators) do
      if type(source) ~= "table" or not valid_did(source.did) then
        error("EvaluationQueryFailed: indexed evaluation contains an invalid evaluator DID", 0)
      end
      local evaluator = {}
      for key, value in pairs(source) do evaluator[key] = value end
      if position <= EVALUATOR_HYDRATION_LIMIT then
        evaluator.hydrationStatus = "hydrated"
        local actor = { did = source.did }
        actors[#actors + 1] = actor
        hydrated_actors[position] = actor
      else
        evaluator.hydrationStatus = "omitted"
        evaluator.profile = nil
        evaluator.organization = nil
      end
      projections[position] = evaluator
    end
    evaluator_projections[view_index] = projections
    evaluator_actors[view_index] = hydrated_actors
  end

  hydrate_actor_views(actors, evaluation_query)

  for view_index, view in ipairs(views) do
    local projections = evaluator_projections[view_index]
    for position, actor in pairs(evaluator_actors[view_index]) do
      projections[position].profile = actor.profile
      projections[position].organization = actor.organization
    end
    view.evaluators = toarray(projections)
  end
end

local function valid_nsid(value)
  if type(value) ~= "string" or #value > 317 then return false end

  local segments = {}
  for segment in value:gmatch("[^%.]+") do segments[#segments + 1] = segment end
  if #segments < 3 or table.concat(segments, ".") ~= value then return false end

  for index = 1, #segments - 1 do
    local segment = segments[index]
    if #segment > 63 or segment:find("[^A-Za-z0-9%-]") then return false end
    local first, last = segment:sub(1, 1), segment:sub(-1)
    if not first:match(index == 1 and "^[A-Za-z]$" or "^[A-Za-z0-9]$")
      or not last:match("^[A-Za-z0-9]$") then
      return false
    end
  end

  local name = segments[#segments]
  return #name <= 63 and name:match("^[A-Za-z][A-Za-z0-9]*$") ~= nil
end

local function evaluation_array(key, format)
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
    if format == "did" and not valid_did(item) then
      invalid("each " .. key .. " value must be a valid DID; resolve handles to DIDs first")
    elseif format == "at-uri" then
      local valid, collection = valid_record_uri(item)
      if not valid or not valid_nsid(collection) then
        invalid("each " .. key .. " value must be a full AT-URI with a DID authority and valid collection NSID")
      end
    end
    if not seen[item] then
      seen[item] = true
      unique[#unique + 1] = item
    end
  end
  return unique
end

local function bind_evaluation_values(values, items)
  local placeholders = {}
  for _, item in ipairs(items) do
    values[#values + 1] = item
    placeholders[#placeholders + 1] = "$" .. #values
  end
  return placeholders
end

local function evaluation_evaluator_match(values, dids)
  local marks = bind_evaluation_values(values, dids)
  local source = "CASE WHEN jsonb_typeof(evaluation.record::jsonb->'evaluators') = 'array' " ..
    "THEN evaluation.record::jsonb->'evaluators' ELSE '[]'::jsonb END"
  return "EXISTS (SELECT 1 FROM jsonb_array_elements(" .. source .. ") AS evaluator(value) " ..
    "WHERE evaluator.value->>'did' IN (" .. table.concat(marks, ", ") .. "))"
end

local function evaluation_sort_expression()
  local created = "evaluation.record::jsonb->>'createdAt'"
  local zoned = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$"
  return "CASE WHEN jsonb_typeof(evaluation.record::jsonb->'createdAt') = 'string' AND " .. created ..
    " ~ '" .. zoned .. "' AND " .. created .. " !~ '-00:00$' AND pg_input_is_valid(" .. created ..
    ", 'timestamptz') THEN (" .. created .. ")::timestamptz ELSE " ..
    "COALESCE(evaluation.indexed_at::timestamptz, evaluation.created_at::timestamptz) END"
end

local function decode_evaluation_cursor(token, direction)
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
  if not valid_datetime(value.t) or not valid or collection ~= EVALUATION then
    invalid("cursor is malformed")
  end
  return value
end

local function evaluation_list_query(authors, evaluators, subjects, limit, cursor, direction)
  local where, values = { "evaluation.collection = $1" }, { EVALUATION }
  if authors then
    if #authors == 0 then
      where[#where + 1] = "FALSE"
    else
      where[#where + 1] = "evaluation.did IN (" ..
        table.concat(bind_evaluation_values(values, authors), ", ") .. ")"
    end
  end
  if evaluators then
    if #evaluators == 0 then
      where[#where + 1] = "FALSE"
    else
      where[#where + 1] = evaluation_evaluator_match(values, evaluators)
    end
  end
  if subjects then
    if #subjects == 0 then
      where[#where + 1] = "FALSE"
    else
      where[#where + 1] = "evaluation.record::jsonb->'subject'->>'uri' IN (" ..
        table.concat(bind_evaluation_values(values, subjects), ", ") .. ")"
    end
  end
  if cursor then
    values[#values + 1] = cursor.t
    local timestamp = "$" .. #values
    values[#values + 1] = cursor.u
    local uri = "$" .. #values
    local operator = direction == "asc" and ">" or "<"
    where[#where + 1] = "(sorted.sort_at, evaluation.uri) " .. operator ..
      " ((" .. timestamp .. ")::timestamptz, " .. uri .. ")"
  end

  values[#values + 1] = limit + 1
  local ordering = direction == "asc" and "ASC" or "DESC"
  local sql = "SELECT evaluation.uri, evaluation.did, evaluation.cid, " ..
    "evaluation.indexed_at::text AS indexed_at, evaluation.record::text AS record, " ..
    "to_char(sorted.sort_at AT TIME ZONE 'UTC', " ..
    "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS sort_timestamp " ..
    "FROM happyview_records AS evaluation CROSS JOIN LATERAL (SELECT " ..
    evaluation_sort_expression() .. " AS sort_at) AS sorted WHERE " .. table.concat(where, " AND ") ..
    " ORDER BY sorted.sort_at " .. ordering .. ", evaluation.uri " .. ordering .. " LIMIT $" .. #values
  local rows = evaluation_query(sql, values)
  local more = #rows > limit
  if more then rows[#rows] = nil end

  local views = {}
  for _, row in ipairs(rows) do views[#views + 1] = evaluation_view(row) end
  hydrate_evaluation_views(views)

  local next_cursor
  if more then
    local last = rows[#rows]
    next_cursor = cursor_encode({ v = 1, d = direction, t = last.sort_timestamp, u = last.uri })
  end
  return views, next_cursor
end

local function list_evaluations()
  keys_only(params, {
    authors = true,
    evaluators = true,
    subjects = true,
    sortDirection = true,
    limit = true,
    cursor = true,
  })

  local authors = evaluation_array("authors", "did")
  local evaluators = evaluation_array("evaluators", "did")
  local subjects = evaluation_array("subjects", "at-uri")
  local direction = parse_sort_direction(params)
  local limit = parse_list_limit(params)
  local cursor = decode_evaluation_cursor(scalar(params, "cursor"), direction)
  local evaluations, next_cursor = evaluation_list_query(authors, evaluators, subjects, limit, cursor, direction)

  local response = { evaluations = toarray(evaluations) }
  if next_cursor then response.cursor = next_cursor end
  return response
end

function handle()
  return list_evaluations()
end

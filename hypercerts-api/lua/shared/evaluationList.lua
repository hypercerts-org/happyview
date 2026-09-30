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
  local views, next_cursor = {}, nil
  -- Bound work when many indexed rows are unrepresentable; the cursor lets callers continue.
  for batch = 1, 10 do
    local page_values, page_where = {}, {}
    for _, value in ipairs(values) do page_values[#page_values + 1] = value end
    for _, clause in ipairs(where) do page_where[#page_where + 1] = clause end
    if cursor then
      page_values[#page_values + 1] = cursor.t
      local timestamp = "$" .. #page_values
      page_values[#page_values + 1] = cursor.u
      local uri = "$" .. #page_values
      local operator = direction == "asc" and ">" or "<"
      page_where[#page_where + 1] = "(sorted.sort_at, evaluation.uri) " .. operator ..
        " ((" .. timestamp .. ")::timestamptz, " .. uri .. ")"
    end

    page_values[#page_values + 1] = limit + 1
    local ordering = direction == "asc" and "ASC" or "DESC"
    local sql = "SELECT evaluation.uri, evaluation.did, evaluation.cid, " ..
      "evaluation.indexed_at::text AS indexed_at, evaluation.record::text AS record, " ..
      "to_char(sorted.sort_at AT TIME ZONE 'UTC', " ..
      "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS sort_timestamp " ..
      "FROM happyview_records AS evaluation CROSS JOIN LATERAL (SELECT " ..
      evaluation_sort_expression() .. " AS sort_at) AS sorted WHERE " .. table.concat(page_where, " AND ") ..
      " ORDER BY sorted.sort_at " .. ordering .. ", evaluation.uri " .. ordering .. " LIMIT $" .. #page_values
    local rows = evaluation_query(sql, page_values)
    local last_scanned
    for index = 1, math.min(#rows, limit) do
      local row = rows[index]
      last_scanned = row
      local view = evaluation_view(row, true)
      if view then views[#views + 1] = view end
      if #views == limit then break end
    end
    if not last_scanned then break end
    cursor = { t = last_scanned.sort_timestamp, u = last_scanned.uri }
    if #views == limit then
      if #rows > limit then
        next_cursor = cursor_encode({ v = 1, d = direction, t = cursor.t, u = cursor.u })
      end
      break
    end
    if #rows <= limit then break end
    if batch == 10 then
      next_cursor = cursor_encode({ v = 1, d = direction, t = cursor.t, u = cursor.u })
    end
  end
  hydrate_evaluation_views(views)
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

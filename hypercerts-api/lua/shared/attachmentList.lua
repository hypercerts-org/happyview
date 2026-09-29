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

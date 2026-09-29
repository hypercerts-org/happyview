local function valid_funding_nsid(value)
  if type(value) ~= "string" or #value < 5 or #value > 317 or value:find("[^A-Za-z0-9.%-]") then
    return false
  end
  local segments = {}
  for segment in value:gmatch("[^.]+") do segments[#segments + 1] = segment end
  if #segments < 3 or table.concat(segments, ".") ~= value then return false end

  for index, segment in ipairs(segments) do
    if #segment > 63 or segment:find("^[%-]") or segment:find("[%-]$") then return false end
    if index == 1 then
      if not segment:match("^[A-Za-z]") then return false end
    elseif index == #segments then
      if not segment:match("^[A-Za-z][A-Za-z0-9]*$") then return false end
    elseif not segment:match("^[A-Za-z0-9]") then
      return false
    end
  end
  return true
end

local function valid_funding_record_uri(value)
  local valid, collection = valid_record_uri(value)
  if not valid or not valid_funding_nsid(collection) then return false, collection end
  return true, collection
end

local function funding_receipt_array(key, format)
  local value = params[key]
  if value == nil then return nil end

  local supplied, occurrences = {}, 0
  if type(value) == "string" then
    supplied[1] = value
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
      supplied[#supplied + 1] = value[index]
    end
  else
    invalid(key .. " must be a string or repeated string parameter")
  end
  if #supplied > 100 then invalid(key .. " accepts at most 100 values") end

  local unique, seen = {}, {}
  for _, item in ipairs(supplied) do
    if format == "did" and not valid_did(item) then
      invalid(key .. " entry " .. string.format("%q", item) .. " must be a valid DID")
    elseif format == "receiptUri" then
      local valid, collection = valid_funding_record_uri(item)
      if not valid or collection ~= RECEIPT then
        invalid(key .. " entry " .. string.format("%q", item) ..
          " must be a full org.hypercerts.funding.receipt AT-URI with a DID authority")
      end
    elseif format == "atUri" then
      local valid = valid_funding_record_uri(item)
      if not valid then
        invalid(key .. " entry " .. string.format("%q", item) ..
          " must be a full record AT-URI with a valid NSID collection and DID authority")
      end
    elseif format == "party" and not valid_did(item) then
      local valid = valid_funding_record_uri(item)
      if not valid then
        invalid(key .. " entry " .. string.format("%q", item) ..
          " must be a valid DID or full record AT-URI; resolve handles to DIDs before querying")
      end
    end

    if not seen[item] then
      seen[item] = true
      unique[#unique + 1] = item
    end
  end
  return unique
end

local function valid_receipt_datetime(value)
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
    local zone_hour, zone_minute = zone:match("^[+-](%d%d):(%d%d)$")
    if not zone_hour or tonumber(zone_hour) > 23 or tonumber(zone_minute) > 59 then return false end
  end
  return true
end

local function decode_funding_receipt_cursor(token, direction)
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
  if not valid_receipt_datetime(value.t) or not valid or collection ~= RECEIPT then
    invalid("cursor is malformed")
  end
  return value
end

local function encode_funding_receipt_cursor(value)
  return (json.encode(value):gsub(".", function(char)
    return string.format("%02x", string.byte(char))
  end))
end

local function bind_funding_receipt_values(values, items)
  local placeholders = {}
  for _, item in ipairs(items) do
    values[#values + 1] = item
    placeholders[#placeholders + 1] = "$" .. #values
  end
  return placeholders
end

local function add_funding_receipt_array_filter(where, values, items, expression)
  if items == nil then return end
  if #items == 0 then where[#where + 1] = "FALSE"; return end
  local marks = bind_funding_receipt_values(values, items)
  where[#where + 1] = expression .. " IN (" .. table.concat(marks, ", ") .. ")"
end

local function add_funding_receipt_party_filter(where, values, key, items)
  if items == nil then return end
  if #items == 0 then where[#where + 1] = "FALSE"; return end

  local dids, uris = {}, {}
  for _, item in ipairs(items) do
    if valid_did(item) then dids[#dids + 1] = item else uris[#uris + 1] = item end
  end
  local record_party = "receipt.record::jsonb->'" .. key .. "'"
  local matches = {}
  if #dids > 0 then
    local did_marks = bind_funding_receipt_values(values, dids)
    matches[#matches + 1] = "(" .. record_party .. "->>'$type' = 'app.certified.defs#did' AND " ..
      record_party .. "->>'did' IN (" .. table.concat(did_marks, ", ") .. "))"
  end
  if #uris > 0 then
    local uri_marks = bind_funding_receipt_values(values, uris)
    matches[#matches + 1] = "(" .. record_party .. "->>'$type' = 'com.atproto.repo.strongRef' AND " ..
      record_party .. "->>'uri' IN (" .. table.concat(uri_marks, ", ") .. "))"
  end
  where[#where + 1] = "(" .. table.concat(matches, " OR ") .. ")"
end

local function funding_receipt_sort_expression()
  local created = "receipt.record::jsonb->>'createdAt'"
  local zoned = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$"
  return "CASE WHEN jsonb_typeof(receipt.record::jsonb->'createdAt') = 'string' AND " .. created ..
    " ~ '" .. zoned .. "' AND " .. created .. " !~ '-00:00$' AND pg_input_is_valid(" .. created ..
    ", 'timestamptz') THEN (" .. created .. ")::timestamptz ELSE " ..
    "COALESCE(receipt.indexed_at::timestamptz, receipt.created_at::timestamptz) END"
end

local function query_funding_receipts(authors, uris, from_values, to_values, for_uris, transaction_ids, limit, cursor, direction)
  local where, values = { "receipt.collection = $1" }, { RECEIPT }
  add_funding_receipt_array_filter(where, values, authors, "receipt.did")
  add_funding_receipt_array_filter(where, values, uris, "receipt.uri")
  add_funding_receipt_party_filter(where, values, "from", from_values)
  add_funding_receipt_party_filter(where, values, "to", to_values)
  add_funding_receipt_array_filter(where, values, for_uris, "receipt.record::jsonb->'for'->>'uri'")
  add_funding_receipt_array_filter(where, values, transaction_ids, "receipt.record::jsonb->>'transactionId'")

  if cursor then
    values[#values + 1] = cursor.t
    local timestamp = "$" .. #values
    values[#values + 1] = cursor.u
    local uri = "$" .. #values
    local operator = direction == "asc" and ">" or "<"
    where[#where + 1] = "(sorted.sort_at, receipt.uri) " .. operator ..
      " ((" .. timestamp .. ")::timestamptz, " .. uri .. ")"
  end

  values[#values + 1] = limit + 1
  local ordering = direction == "asc" and "ASC" or "DESC"
  local sql = "SELECT receipt.uri, receipt.did, receipt.cid, receipt.indexed_at::text AS indexed_at, " ..
    "receipt.record::text AS record, to_char(sorted.sort_at AT TIME ZONE 'UTC', " ..
    "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS sort_timestamp " ..
    "FROM happyview_records AS receipt CROSS JOIN LATERAL (SELECT " ..
    funding_receipt_sort_expression() .. " AS sort_at) AS sorted WHERE " .. table.concat(where, " AND ") ..
    " ORDER BY sorted.sort_at " .. ordering .. ", receipt.uri " .. ordering .. " LIMIT $" .. #values
  local rows = receipt_query(sql, values)
  local more = #rows > limit
  if more then rows[#rows] = nil end

  local receipts = {}
  for _, row in ipairs(rows) do receipts[#receipts + 1] = funding_receipt_view(row) end
  hydrate_funding_receipt_views(receipts)

  local next_cursor
  if more then
    local last = rows[#rows]
    next_cursor = encode_funding_receipt_cursor({ v = 1, d = direction, t = last.sort_timestamp, u = last.uri })
  end
  return receipts, next_cursor
end

local function funding_receipts_response()
  keys_only(params, {
    authors = true,
    uris = true,
    from = true,
    to = true,
    forUris = true,
    transactionIds = true,
    sortDirection = true,
    limit = true,
    cursor = true,
  })

  local authors = funding_receipt_array("authors", "did")
  local uris = funding_receipt_array("uris", "receiptUri")
  local from_values = funding_receipt_array("from", "party")
  local to_values = funding_receipt_array("to", "party")
  local for_uris = funding_receipt_array("forUris", "atUri")
  local transaction_ids = funding_receipt_array("transactionIds")

  local direction = scalar(params, "sortDirection") or "desc"
  if direction ~= "asc" and direction ~= "desc" then
    invalid("sortDirection must be 'asc' or 'desc'")
  end
  local limit_value = scalar(params, "limit")
  if limit_value and not limit_value:match("^%d+$") then
    invalid("limit must be an integer from 1 through 100")
  end
  local limit = limit_value and tonumber(limit_value) or 25
  if not limit or limit % 1 ~= 0 or limit < 1 or limit > 100 then
    invalid("limit must be an integer from 1 through 100")
  end
  local cursor = decode_funding_receipt_cursor(scalar(params, "cursor"), direction)
  local receipts, next_cursor = query_funding_receipts(
    authors, uris, from_values, to_values, for_uris, transaction_ids, limit, cursor, direction)
  local response = { receipts = toarray(receipts) }
  if next_cursor then response.cursor = next_cursor end
  return response
end

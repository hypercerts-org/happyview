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

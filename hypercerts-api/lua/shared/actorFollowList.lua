local function valid_follow_uri(value)
  local valid, collection = valid_record_uri(value)
  return valid and collection == FOLLOW
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
  if not valid_follow_uri(value.u) or not valid_datetime(value.t) then invalid("cursor is malformed") end
  return value
end

local function query_actor_follows(mode, actor, limit, cursor, direction)
  local filters, values = { "collection = $1" }, { FOLLOW }
  values[#values + 1] = actor
  if mode == "followers" then
    filters[#filters + 1] = "record::jsonb->>'subject' = $2"
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
  local displayed_did = mode == "followers" and "did" or "subject_did"
  local sql = "WITH ranked_follows AS (SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record, record::jsonb->>'subject' AS subject_did, (record::jsonb->>'createdAt')::timestamptz AS sort_at, ROW_NUMBER() OVER (PARTITION BY did, record::jsonb->>'subject' ORDER BY (record::jsonb->>'createdAt')::timestamptz ASC, uri ASC) AS relationship_rank FROM happyview_records WHERE " .. table.concat(filters, " AND ") .. "), representatives AS (SELECT uri, did, cid, indexed_at, record, sort_at, " .. displayed_did .. " AS actor_did FROM ranked_follows WHERE relationship_rank = 1), " ..
    "total AS (SELECT COUNT(*) AS total_count FROM representatives), " ..
    "page AS (SELECT uri, did, cid, indexed_at, record, sort_at, actor_did FROM representatives" .. cursor_filter .. " ORDER BY sort_at " .. ordering .. ", uri " .. ordering .. " LIMIT $" .. #values .. ") " ..
    "SELECT page.uri, page.did, page.cid, page.indexed_at, page.record, page.actor_did, total.total_count, to_char(page.sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS sort_timestamp FROM total LEFT JOIN page ON TRUE ORDER BY page.sort_at " .. ordering .. ", page.uri " .. ordering
  local rows = query(sql, values)
  local total_count = rows[1] and tonumber(rows[1].total_count)
  if not total_count or total_count < 0 or total_count % 1 ~= 0 then error("ActorFollowQueryFailed: actor-follow count unavailable", 0) end
  if rows[1].uri == nil then rows = {} end
  local more = #rows > limit
  if more then rows[#rows] = nil end

  local views = {}
  for _, row in ipairs(rows) do
    views[#views + 1] = { did = row.actor_did, follow = record_view(row) }
  end
  hydrate_actor_views(views, query)

  local next_cursor
  if more then
    local last = rows[#rows]
    next_cursor = cursor_encode({ v = 1, d = direction, t = last.sort_timestamp, u = last.uri })
  end
  return views, next_cursor, total_count
end

local function list_actor_follows(mode)
  keys_only(params, { actor = true, sortDirection = true, limit = true, cursor = true })
  local actor = scalar(params, "actor")
  if not actor or not valid_did(actor) then invalid("actor must be a valid DID") end

  local limit = parse_list_limit(params)
  local direction = parse_sort_direction(params)
  local cursor = cursor_decode(scalar(params, "cursor"), direction)
  local views, next_cursor, total_count = query_actor_follows(mode, actor, limit, cursor, direction)
  local response = { [mode] = toarray(views), totalCount = total_count }
  if next_cursor then response.cursor = next_cursor end
  return response
end

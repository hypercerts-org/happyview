local ACTIVITY = "org.hypercerts.claim.activity"
local CONTRIBUTOR_INFORMATION = "org.hypercerts.claim.contributorInformation"
local PROFILE = "app.certified.actor.profile"
local ORGANIZATION = "app.certified.actor.organization"
local NULL = json.decode("null")

local function invalid(message)
  error("InvalidRequest: " .. message, 0)
end

local function keys_only(values, allowed)
  for key in pairs(values) do
    if not allowed[key] then invalid("unknown query parameter: " .. key) end
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

local function valid_record_key(value)
  return #value >= 1 and #value <= 512 and value ~= "." and value ~= ".."
    and not value:find("[^%w_~%.:%-]")
end

local function valid_record_uri(value)
  if type(value) ~= "string" or value:find("[?#]") then return false end
  local authority, collection, rkey = value:match("^at://([^/]+)/([^/]+)/([^/]+)$")
  if not authority or not valid_did(authority) or not valid_record_key(rkey) then return false end
  return true, collection, authority
end

local function query(sql, values)
  if db.backend() ~= "postgres" then error("ActivityQueryFailed: activity API requires PostgreSQL", 0) end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("ActivityQueryFailed: activity lookup failed", 0)
  end
  return result
end

local function record_view(row, nullable_indexed_at)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and nullable_indexed_at and NULL or row.indexed_at,
    did = row.did,
    record = json.decode(row.record),
  }
end

local function identity_did(identifier)
  if valid_did(identifier) then return identifier end
  local valid, _, authority = valid_record_uri(identifier)
  if valid then return authority end
  return nil
end

local function identity_key(uri, cid)
  return uri .. "\0" .. cid
end

local function load_contributor_information(references)
  local rows_by_version = {}
  for first = 1, #references, 500 do
    local values, predicates = { CONTRIBUTOR_INFORMATION }, {}
    local last = math.min(first + 499, #references)
    for index = first, last do
      local reference = references[index]
      values[#values + 1] = reference.uri
      local uri_parameter = "$" .. #values
      values[#values + 1] = reference.cid
      local cid_parameter = "$" .. #values
      predicates[#predicates + 1] = "(uri = " .. uri_parameter .. " AND cid = " .. cid_parameter .. ")"
    end
    local rows = query(
      "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
        "FROM happyview_records WHERE collection = $1 AND (" .. table.concat(predicates, " OR ") .. ")",
      values)
    for _, row in ipairs(rows) do rows_by_version[identity_key(row.uri, row.cid)] = row end
  end
  return rows_by_version
end

local function load_actor_records(collection, dids)
  if #dids == 0 then return {} end
  local values, placeholders = { collection }, {}
  for _, did in ipairs(dids) do
    values[#values + 1] = did
    placeholders[#placeholders + 1] = "$" .. #values
  end
  local rows = query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN (" .. table.concat(placeholders, ", ") .. ")",
    values)
  local by_did = {}
  for _, row in ipairs(rows) do by_did[row.did] = row end
  return by_did
end

local function add_unique(values, seen, value)
  if not seen[value] then
    seen[value] = true
    values[#values + 1] = value
  end
end

local function activity_view(row)
  local record = json.decode(row.record)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and NULL or row.indexed_at,
    did = row.did,
    author = { did = row.did },
    record = record,
  }
end

local function hydrate_activity_views(views)
  local references, seen_references = {}, {}
  local author_dids, seen_authors = {}, {}
  local profile_dids, seen_profiles = {}, {}
  local projected_contributors, contributor_resolutions = {}, {}

  for view_index, view in ipairs(views) do
    add_unique(author_dids, seen_authors, view.did)
    add_unique(profile_dids, seen_profiles, view.did)
    local source_contributors = view.record.contributors
    if source_contributors ~= nil then
      if type(source_contributors) ~= "table" then
        error("ActivityQueryFailed: activity contributors are not an array", 0)
      end
      local projections = {}
      for contributor_index, source in ipairs(source_contributors) do
        local projection = {}
        for key, value in pairs(source) do projection[key] = value end
        projection.contributorInformation = NULL
        projection.actor = NULL
        projections[contributor_index] = projection

        local identity = source.contributorIdentity
        local resolution = { projection = projection }
        if type(identity) == "table" and type(identity.uri) == "string" and type(identity.cid) == "string" then
          local key = identity_key(identity.uri, identity.cid)
          resolution.information_key = key
          if not seen_references[key] then
            seen_references[key] = true
            references[#references + 1] = { uri = identity.uri, cid = identity.cid }
          end
        elseif type(identity) == "table" then
          resolution.identifier = identity.identity
        end
        contributor_resolutions[#contributor_resolutions + 1] = resolution
      end
      projected_contributors[view_index] = projections
    end
  end

  local contributor_information = load_contributor_information(references)
  for _, resolution in ipairs(contributor_resolutions) do
    local projection = resolution.projection
    local identifier = resolution.identifier
    if resolution.information_key then
      local row = contributor_information[resolution.information_key]
      if row then
        local information = record_view(row, true)
        projection.contributorInformation = information
        identifier = information.record.identifier
      end
    end
    local did = identity_did(identifier)
    if did then
      projection.actor = { did = did }
      add_unique(profile_dids, seen_profiles, did)
    end
  end

  local profiles = load_actor_records(PROFILE, profile_dids)
  local organizations = load_actor_records(ORGANIZATION, author_dids)
  for _, view in ipairs(views) do
    local author = view.author
    author.profile = profiles[author.did] and record_view(profiles[author.did]) or NULL
    author.organization = organizations[author.did] and record_view(organizations[author.did]) or NULL
  end
  for _, projections in pairs(projected_contributors) do
    for _, projection in ipairs(projections) do
      local actor = projection.actor
      if actor ~= NULL then
        actor.profile = profiles[actor.did] and record_view(profiles[actor.did]) or NULL
      end
    end
  end

  for view_index, projections in pairs(projected_contributors) do
    views[view_index].contributors = toarray(projections)
  end
end

local function activity_array(key, format)
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
    elseif format == "activityUri" then
      local valid, collection = valid_record_uri(item)
      if not valid or collection ~= ACTIVITY then
        invalid("each uris value must be a full org.hypercerts.claim.activity AT-URI with a DID authority")
      end
    end
    if not seen[item] then
      seen[item] = true
      unique[#unique + 1] = item
    end
  end
  return unique
end

local function integer_limit()
  local value = scalar(params, "limit")
  if value == nil then return 25 end
  if not value:match("^%d+$") then invalid("limit must be an integer from 1 through 100") end
  local number = tonumber(value)
  if not number or number < 1 or number > 100 then
    invalid("limit must be an integer from 1 through 100")
  end
  return number
end

local function valid_activity_datetime(value)
  if type(value) ~= "string" then return false end
  local year, month, day, hour, minute, second, suffix = value:match(
    "^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)(.*)$")
  if not year then return false end
  year, month, day = tonumber(year), tonumber(month), tonumber(day)
  hour, minute, second = tonumber(hour), tonumber(minute), tonumber(second)
  if month < 1 or month > 12 or hour > 23 or minute > 59 or second > 59 then return false end
  local leap = year % 4 == 0 and (year % 100 ~= 0 or year % 400 == 0)
  local days = { 31, leap and 29 or 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
  if day < 1 or day > days[month] then return false end
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

local function decode_activity_cursor(token, direction)
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
  if not valid_activity_datetime(value.t) or not valid or collection ~= ACTIVITY then
    invalid("cursor is malformed")
  end
  return value
end

local function encode_activity_cursor(value)
  return (json.encode(value):gsub(".", function(char)
    return string.format("%02x", string.byte(char))
  end))
end

local function bind_values(values, items)
  local placeholders = {}
  for _, item in ipairs(items) do
    values[#values + 1] = item
    placeholders[#placeholders + 1] = "$" .. #values
  end
  return placeholders
end

local function activity_contributor_match(values, dids)
  local marks = bind_values(values, dids)
  local set = table.concat(marks, ", ")
  local identity = "contributor.value->'contributorIdentity'->>'identity'"
  local information_identifier = "ci.record::jsonb->>'identifier'"
  return "EXISTS (SELECT 1 FROM jsonb_array_elements(" ..
    "CASE WHEN jsonb_typeof(activity.record::jsonb->'contributors') = 'array' " ..
    "THEN activity.record::jsonb->'contributors' ELSE '[]'::jsonb END) AS contributor(value) " ..
    "LEFT JOIN happyview_records AS ci ON ci.collection = 'org.hypercerts.claim.contributorInformation' " ..
    "AND ci.uri = (contributor.value->'contributorIdentity'->>'uri') " ..
    "AND ci.cid = (contributor.value->'contributorIdentity'->>'cid') " ..
    "WHERE (" .. identity .. " IN (" .. set .. ") " ..
    "OR substring(" .. identity .. " from '^at://([^/]+)/') IN (" .. set .. ") " ..
    "OR " .. information_identifier .. " IN (" .. set .. ") " ..
    "OR substring(" .. information_identifier .. " from '^at://([^/]+)/') IN (" .. set .. ")))"
end

local function activity_sort_expression()
  local created = "activity.record::jsonb->>'createdAt'"
  local zoned = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$"
  return "CASE WHEN jsonb_typeof(activity.record::jsonb->'createdAt') = 'string' AND " .. created ..
    " ~ '" .. zoned .. "' AND " .. created .. " !~ '-00:00$' AND pg_input_is_valid(" .. created ..
    ", 'timestamptz') THEN (" .. created .. ")::timestamptz ELSE " ..
    "COALESCE(activity.indexed_at::timestamptz, activity.created_at::timestamptz) END"
end

local function activity_query(authors, author_type, contributors, involved_actors, uris, search, limit, cursor, direction)
  local where, values = { "activity.collection = $1" }, { ACTIVITY }
  if authors then
    if #authors == 0 then
      where[#where + 1] = "FALSE"
    else
      where[#where + 1] = "activity.did IN (" .. table.concat(bind_values(values, authors), ", ") .. ")"
    end
  end
  if author_type == "organization" then
    where[#where + 1] = "EXISTS (SELECT 1 FROM happyview_records AS organization " ..
      "WHERE organization.collection = 'app.certified.actor.organization' AND organization.rkey = 'self' " ..
      "AND organization.did = activity.did)"
  elseif author_type == "person" then
    where[#where + 1] = "EXISTS (SELECT 1 FROM happyview_records AS profile " ..
      "WHERE profile.collection = 'app.certified.actor.profile' AND profile.rkey = 'self' AND profile.did = activity.did)"
    where[#where + 1] = "NOT EXISTS (SELECT 1 FROM happyview_records AS organization " ..
      "WHERE organization.collection = 'app.certified.actor.organization' AND organization.rkey = 'self' " ..
      "AND organization.did = activity.did)"
  end
  if contributors then
    if #contributors == 0 then where[#where + 1] = "FALSE"
    else where[#where + 1] = activity_contributor_match(values, contributors) end
  end
  if involved_actors then
    if #involved_actors == 0 then
      where[#where + 1] = "FALSE"
    else
      local marks = bind_values(values, involved_actors)
      where[#where + 1] = "(activity.did IN (" .. table.concat(marks, ", ") .. ") OR " ..
        activity_contributor_match(values, involved_actors) .. ")"
    end
  end
  if uris then
    if #uris == 0 then where[#where + 1] = "FALSE"
    else where[#where + 1] = "activity.uri IN (" .. table.concat(bind_values(values, uris), ", ") .. ")" end
  end
  if search ~= nil then
    values[#values + 1] = search
    local pattern = "$" .. #values
    where[#where + 1] = "(strpos(lower(COALESCE(activity.record::jsonb->>'title', '')), lower(" .. pattern .. ")) > 0 " ..
      "OR strpos(lower(COALESCE(activity.record::jsonb->>'shortDescription', '')), lower(" .. pattern .. ")) > 0)"
  end
  if cursor then
    values[#values + 1] = cursor.t
    local timestamp = "$" .. #values
    values[#values + 1] = cursor.u
    local uri = "$" .. #values
    local operator = direction == "asc" and ">" or "<"
    where[#where + 1] = "(sorted.sort_at, activity.uri) " .. operator ..
      " ((" .. timestamp .. ")::timestamptz, " .. uri .. ")"
  end

  values[#values + 1] = limit + 1
  local ordering = direction == "asc" and "ASC" or "DESC"
  local sql = "SELECT activity.uri, activity.did, activity.cid, activity.indexed_at::text AS indexed_at, " ..
    "activity.record::text AS record, to_char(sorted.sort_at AT TIME ZONE 'UTC', " ..
    "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS sort_timestamp " ..
    "FROM happyview_records AS activity CROSS JOIN LATERAL (SELECT " .. activity_sort_expression() .. " AS sort_at) AS sorted " ..
    "WHERE " .. table.concat(where, " AND ") .. " ORDER BY sorted.sort_at " .. ordering ..
    ", activity.uri " .. ordering .. " LIMIT $" .. #values
  local rows = query(sql, values)
  local more = #rows > limit
  if more then rows[#rows] = nil end

  local views = {}
  for _, row in ipairs(rows) do views[#views + 1] = activity_view(row) end
  hydrate_activity_views(views)

  local next_cursor
  if more then
    local last = rows[#rows]
    next_cursor = encode_activity_cursor({ v = 1, d = direction, t = last.sort_timestamp, u = last.uri })
  end
  return views, next_cursor
end

local function activity_list_response(search_enabled)
  local allowed = {
    authors = true,
    authorType = true,
    contributors = true,
    involvedActors = true,
    uris = true,
    sortDirection = true,
    limit = true,
    cursor = true,
  }
  if search_enabled then allowed.search = true end
  keys_only(params, allowed)

  local authors = activity_array("authors", "did")
  local contributors = activity_array("contributors", "did")
  local involved_actors = activity_array("involvedActors", "did")
  local uris = activity_array("uris", "activityUri")
  local author_type = scalar(params, "authorType")
  if author_type ~= nil and author_type ~= "person" and author_type ~= "organization" then
    invalid("authorType must be 'person' or 'organization'")
  end
  local search
  if search_enabled then
    search = scalar(params, "search")
    if search == nil then invalid("search is required") end
    search = search:match("^%s*(.-)%s*$")
    if search == "" then search = nil end
  end
  local direction = scalar(params, "sortDirection") or "desc"
  if direction ~= "asc" and direction ~= "desc" then invalid("sortDirection must be 'asc' or 'desc'") end
  local limit = integer_limit()
  local cursor = decode_activity_cursor(scalar(params, "cursor"), direction)
  local activities, next_cursor = activity_query(
    authors, author_type, contributors, involved_actors, uris, search, limit, cursor, direction)
  local response = { activities = toarray(activities) }
  if next_cursor then response.cursor = next_cursor end
  return response
end

function handle()
  return activity_list_response(false)
end

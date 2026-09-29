local COLLECTION = "org.hypercerts.collection"
local PROFILE = "app.certified.actor.profile"
local ORGANIZATION = "app.certified.actor.organization"
local LOCATION = "app.certified.location"
local VOCAB_TAG = "org.hypercerts.vocab.tag"
local COLLECTION_NULL = json.decode("null")

local function collection_invalid(message)
  error("InvalidRequest: " .. message, 0)
end

local function collection_keys_only(values, allowed)
  for key in pairs(values) do
    if not allowed[key] then collection_invalid("unknown query parameter: " .. key) end
  end
end

local function collection_scalar(values, key)
  local value = values[key]
  if value == nil then return nil end
  if key == "hasOrganizationRecord" and type(value) == "boolean" then return tostring(value) end
  if type(value) ~= "string" and type(value) ~= "number" then
    collection_invalid(key .. " must occur once")
  end
  return tostring(value)
end

local function collection_valid_did(value)
  if type(value) ~= "string" or #value > 2048 then return false end
  local method, specific = value:match("^did:([a-z]+):(.+)$")
  if not method or not specific or specific:sub(-1) == ":" or specific:sub(-1) == "%"
    or value:find("[^%w%.:_%%%-]") then return false end
  return true
end

local function collection_valid_record_key(value)
  return #value >= 1 and #value <= 512 and value ~= "." and value ~= ".."
    and not value:find("[^%w_~%.:%-]")
end

local function collection_valid_record_uri(value)
  if type(value) ~= "string" or #value > 8192 or value:find("[?#]") then return false end
  local authority, collection, rkey = value:match("^at://([^/]+)/([^/]+)/([^/]+)$")
  if not authority or not collection_valid_did(authority) or not collection_valid_record_key(rkey) then return false end
  return true, collection, authority
end

local function collection_query(sql, values)
  if db.backend() ~= "postgres" then
    error("CollectionQueryFailed: collection API requires PostgreSQL", 0)
  end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("CollectionQueryFailed: collection lookup failed", 0)
  end
  return result
end

local function collection_record_view(row)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and COLLECTION_NULL or row.indexed_at,
    did = row.did,
    record = json.decode(row.record),
  }
end

local function collection_ref_key(uri, cid)
  return uri .. "\0" .. cid
end

local function collection_add_unique(values, seen, value)
  if not seen[value] then
    seen[value] = true
    values[#values + 1] = value
  end
end

local function collection_load_actor_records(collection, dids)
  if #dids == 0 then return {} end
  local values, placeholders = { collection }, {}
  for _, did in ipairs(dids) do
    values[#values + 1] = did
    placeholders[#placeholders + 1] = "$" .. #values
  end
  local rows = collection_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN (" .. table.concat(placeholders, ", ") .. ")",
    values)
  local by_did = {}
  for _, row in ipairs(rows) do by_did[row.did] = row end
  return by_did
end

local function collection_load_exact_refs(collection, references)
  local rows_by_version = {}
  for first = 1, #references, 300 do
    local values, predicates = { collection }, {}
    local last = math.min(first + 299, #references)
    for index = first, last do
      local reference = references[index]
      values[#values + 1] = reference.uri
      local uri_parameter = "$" .. #values
      values[#values + 1] = reference.cid
      local cid_parameter = "$" .. #values
      predicates[#predicates + 1] = "(uri = " .. uri_parameter .. " AND cid = " .. cid_parameter .. ")"
    end
    local rows = collection_query(
      "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
        "FROM happyview_records WHERE collection = $1 AND (" .. table.concat(predicates, " OR ") .. ")",
      values)
    for _, row in ipairs(rows) do
      rows_by_version[collection_ref_key(row.uri, row.cid)] = row
    end
  end
  return rows_by_version
end

local function collection_reference(value, field, expected_collection)
  if type(value) ~= "table" or type(value.uri) ~= "string" or type(value.cid) ~= "string" then
    error("CollectionQueryFailed: indexed collection has an invalid " .. field .. " reference", 0)
  end
  local valid, collection = collection_valid_record_uri(value.uri)
  if not valid or (expected_collection and collection ~= expected_collection) then
    error("CollectionQueryFailed: indexed collection has an invalid " .. field .. " reference", 0)
  end
  return { uri = value.uri, cid = value.cid }
end

local function collection_view(row)
  local record = json.decode(row.record)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and COLLECTION_NULL or row.indexed_at,
    did = row.did,
    author = { did = row.did },
    record = record,
  }
end

local function collection_hydrate(views)
  if #views == 0 then return end

  local author_dids, seen_authors = {}, {}
  local location_refs, seen_locations = {}, {}
  local tag_refs, seen_tags = {}, {}
  for _, view in ipairs(views) do
    collection_add_unique(author_dids, seen_authors, view.did)
    if view.record.location ~= nil then
      local reference = collection_reference(view.record.location, "location", LOCATION)
      local key = collection_ref_key(reference.uri, reference.cid)
      if not seen_locations[key] then
        seen_locations[key] = true
        location_refs[#location_refs + 1] = reference
      end
    end
    if view.record.tags ~= nil then
      if type(view.record.tags) ~= "table" then
        error("CollectionQueryFailed: indexed collection tags are not an array", 0)
      end
      for _, source in ipairs(view.record.tags) do
        local reference = collection_reference(source, "tag", VOCAB_TAG)
        local key = collection_ref_key(reference.uri, reference.cid)
        if not seen_tags[key] then
          seen_tags[key] = true
          reference.key = key
          tag_refs[#tag_refs + 1] = reference
        end
      end
    end
  end

  local profiles = collection_load_actor_records(PROFILE, author_dids)
  local organizations = collection_load_actor_records(ORGANIZATION, author_dids)
  local locations = collection_load_exact_refs(LOCATION, location_refs)
  local tags = collection_load_exact_refs(VOCAB_TAG, tag_refs)

  for _, view in ipairs(views) do
    view.author.profile = profiles[view.did] and collection_record_view(profiles[view.did]) or COLLECTION_NULL
    view.author.organization = organizations[view.did] and collection_record_view(organizations[view.did]) or COLLECTION_NULL

    local source_location = view.record.location
    if source_location ~= nil then
      local key = collection_ref_key(source_location.uri, source_location.cid)
      local row = locations[key]
      view.location = {
        uri = source_location.uri,
        cid = source_location.cid,
        record = row and collection_record_view(row) or COLLECTION_NULL,
      }
    end

    local source_tags = view.record.tags
    if source_tags ~= nil then
      local projected_tags = {}
      for index, source in ipairs(source_tags) do
        local row = tags[collection_ref_key(source.uri, source.cid)]
        projected_tags[index] = {
          uri = source.uri,
          cid = source.cid,
          record = row and collection_record_view(row) or COLLECTION_NULL,
        }
      end
      view.tags = toarray(projected_tags)
    end
  end
end

local function collection_array(key, kind)
  local value = params[key]
  if value == nil then return nil end

  local supplied = {}
  if type(value) == "string" then
    supplied[1] = value
  elseif type(value) == "table" then
    local count = 0
    for index in pairs(value) do
      if type(index) ~= "number" or index < 1 or index % 1 ~= 0 then
        collection_invalid(key .. " must use repeated query values")
      end
      count = count + 1
    end
    if count ~= #value then collection_invalid(key .. " must use repeated query values") end
    for index = 1, count do
      if type(value[index]) ~= "string" then collection_invalid(key .. " entries must be strings") end
      supplied[#supplied + 1] = value[index]
    end
  else
    collection_invalid(key .. " must be a string or repeated string parameter")
  end
  if #supplied > 100 then collection_invalid(key .. " accepts at most 100 values") end

  local unique, seen = {}, {}
  for _, item in ipairs(supplied) do
    if kind == "did" and not collection_valid_did(item) then
      collection_invalid("each authors value must be a valid DID; resolve handles to DIDs first")
    elseif kind == "collectionUri" then
      local valid, collection = collection_valid_record_uri(item)
      if not valid or collection ~= COLLECTION then
        collection_invalid("each uris value must be a full org.hypercerts.collection AT-URI with a DID authority")
      end
    elseif kind == "recordUri" then
      if not collection_valid_record_uri(item) then
        collection_invalid("each " .. key .. " value must be a full AT-URI with a DID authority")
      end
    elseif kind == "tagUri" then
      local valid, collection = collection_valid_record_uri(item)
      if not valid or collection ~= "org.hypercerts.vocab.tag" then
        collection_invalid("each tagUris value must be a full org.hypercerts.vocab.tag AT-URI with a DID authority")
      end
    elseif kind == "type" and #item > 64 then
      collection_invalid("types entries must be at most 64 UTF-8 bytes")
    end
    if not seen[item] then
      seen[item] = true
      unique[#unique + 1] = item
    end
  end
  return unique
end

local function collection_list_limit()
  local value = collection_scalar(params, "limit")
  if value == nil then return 25 end
  if not value:match("^%d+$") then collection_invalid("limit must be an integer from 1 through 100") end
  local limit = tonumber(value)
  if not limit or limit < 1 or limit > 100 then
    collection_invalid("limit must be an integer from 1 through 100")
  end
  return limit
end

local function collection_valid_datetime(value)
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

local function collection_list_cursor_decode(token, direction)
  if token == nil then return nil end
  if #token == 0 or #token > 8192 or #token % 2 ~= 0 or token:find("[^0-9a-f]") then
    collection_invalid("cursor is malformed")
  end
  local decoded = token:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end)
  local ok, value = pcall(json.decode, decoded)
  if not ok or type(value) ~= "table" or value.v ~= 1 or value.d ~= direction
    or type(value.t) ~= "string" or type(value.u) ~= "string" then
    collection_invalid("cursor is malformed or belongs to another sortDirection")
  end
  for key in pairs(value) do
    if key ~= "v" and key ~= "d" and key ~= "t" and key ~= "u" then
      collection_invalid("cursor is malformed")
    end
  end
  local valid, collection = collection_valid_record_uri(value.u)
  if not collection_valid_datetime(value.t) or not valid or collection ~= COLLECTION then
    collection_invalid("cursor is malformed")
  end
  return value
end

local function collection_cursor_encode(value)
  return (json.encode(value):gsub(".", function(char)
    return string.format("%02x", string.byte(char))
  end))
end

local function collection_bind_values(values, items)
  local placeholders = {}
  for _, item in ipairs(items) do
    values[#values + 1] = item
    placeholders[#placeholders + 1] = "$" .. #values
  end
  return placeholders
end

local function collection_list_query(filters, search, limit, cursor, direction)
  local where, values = { "collection.collection = $1" }, { COLLECTION }

  if filters.authors then
    if #filters.authors == 0 then
      where[#where + 1] = "FALSE"
    else
      where[#where + 1] = "collection.did IN (" .. table.concat(collection_bind_values(values, filters.authors), ", ") .. ")"
    end
  end
  if filters.hasOrganizationRecord ~= nil then
    local predicate = filters.hasOrganizationRecord and "EXISTS" or "NOT EXISTS"
    where[#where + 1] = predicate .. " (SELECT 1 FROM happyview_records AS organization " ..
      "WHERE organization.collection = 'app.certified.actor.organization' AND organization.rkey = 'self' " ..
      "AND organization.did = collection.did)"
  end
  if filters.types then
    if #filters.types == 0 then
      where[#where + 1] = "FALSE"
    else
      where[#where + 1] = "collection.record::jsonb->>'type' IN (" ..
        table.concat(collection_bind_values(values, filters.types), ", ") .. ")"
    end
  end
  if filters.uris then
    if #filters.uris == 0 then
      where[#where + 1] = "FALSE"
    else
      where[#where + 1] = "collection.uri IN (" .. table.concat(collection_bind_values(values, filters.uris), ", ") .. ")"
    end
  end
  if filters.itemUris then
    if #filters.itemUris == 0 then
      where[#where + 1] = "FALSE"
    else
      local item_marks = collection_bind_values(values, filters.itemUris)
      where[#where + 1] = "EXISTS (SELECT 1 FROM jsonb_array_elements(" ..
        "CASE WHEN jsonb_typeof(collection.record::jsonb->'items') = 'array' " ..
        "THEN collection.record::jsonb->'items' ELSE '[]'::jsonb END) AS item(value) " ..
        "WHERE item.value->'itemIdentifier'->>'uri' IN (" .. table.concat(item_marks, ", ") .. "))"
    end
  end
  if filters.tagUris then
    for _, tag_uri in ipairs(filters.tagUris) do
      values[#values + 1] = tag_uri
      local tag_parameter = "$" .. #values
      where[#where + 1] = "EXISTS (SELECT 1 FROM jsonb_array_elements(" ..
        "CASE WHEN jsonb_typeof(collection.record::jsonb->'tags') = 'array' " ..
        "THEN collection.record::jsonb->'tags' ELSE '[]'::jsonb END) AS tag(value) " ..
        "WHERE tag.value->>'uri' = " .. tag_parameter .. ")"
    end
  end
  if search ~= nil then
    values[#values + 1] = search
    local text = "$" .. #values
    where[#where + 1] = "(strpos(lower(COALESCE(collection.record::jsonb->>'title', '')), lower(" .. text .. ")) > 0 " ..
      "OR strpos(lower(COALESCE(collection.record::jsonb->>'shortDescription', '')), lower(" .. text .. ")) > 0)"
  end
  if cursor then
    values[#values + 1] = cursor.t
    local timestamp = "$" .. #values
    values[#values + 1] = cursor.u
    local uri = "$" .. #values
    local operator = direction == "asc" and ">" or "<"
    where[#where + 1] = "(sorted.sort_at, collection.uri) " .. operator ..
      " ((" .. timestamp .. ")::timestamptz, " .. uri .. ")"
  end

  values[#values + 1] = limit + 1
  local ordering = direction == "asc" and "ASC" or "DESC"
  local created = "collection.record::jsonb->>'createdAt'"
  local zoned = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$"
  local sort_key = "CASE WHEN jsonb_typeof(collection.record::jsonb->'createdAt') = 'string' AND " .. created ..
    " ~ '" .. zoned .. "' AND " .. created .. " !~ '-00:00$' AND pg_input_is_valid(" .. created ..
    ", 'timestamptz') THEN (" .. created .. ")::timestamptz ELSE " ..
    "COALESCE(collection.indexed_at::timestamptz, collection.created_at::timestamptz) END"
  local sql = "SELECT collection.uri, collection.did, collection.cid, collection.indexed_at::text AS indexed_at, " ..
    "collection.record::text AS record, to_char(sorted.sort_at AT TIME ZONE 'UTC', " ..
    "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS sort_timestamp " ..
    "FROM happyview_records AS collection CROSS JOIN LATERAL (SELECT " .. sort_key .. " AS sort_at) AS sorted " ..
    "WHERE " .. table.concat(where, " AND ") .. " ORDER BY sorted.sort_at " .. ordering ..
    ", collection.uri " .. ordering .. " LIMIT $" .. #values

  local rows = collection_query(sql, values)
  local more = #rows > limit
  if more then rows[#rows] = nil end

  local views = {}
  for _, row in ipairs(rows) do views[#views + 1] = collection_view(row) end
  collection_hydrate(views)

  local next_cursor
  if more then
    local last = rows[#rows]
    next_cursor = collection_cursor_encode({ v = 1, d = direction, t = last.sort_timestamp, u = last.uri })
  end
  return views, next_cursor
end

local function collection_list_response(search_enabled)
  local allowed = {
    authors = true,
    hasOrganizationRecord = true,
    types = true,
    uris = true,
    itemUris = true,
    tagUris = true,
    sortDirection = true,
    limit = true,
    cursor = true,
  }
  if search_enabled then allowed.search = true end
  collection_keys_only(params, allowed)

  local authors = collection_array("authors", "did")
  local has_organization_record = collection_scalar(params, "hasOrganizationRecord")
  if has_organization_record ~= nil then
    if has_organization_record == "true" then
      has_organization_record = true
    elseif has_organization_record == "false" then
      has_organization_record = false
    else
      collection_invalid("hasOrganizationRecord must be true or false")
    end
  end
  local types = collection_array("types", "type")
  local uris = collection_array("uris", "collectionUri")
  local item_uris = collection_array("itemUris", "recordUri")
  local tag_uris = collection_array("tagUris", "tagUri")
  local search
  if search_enabled then
    search = collection_scalar(params, "search")
    if search == nil then collection_invalid("search is required") end
    search = search:match("^%s*(.-)%s*$")
    if search == "" then search = nil end
  end
  local direction = collection_scalar(params, "sortDirection") or "desc"
  if direction ~= "asc" and direction ~= "desc" then
    collection_invalid("sortDirection must be 'asc' or 'desc'")
  end
  local limit = collection_list_limit()
  local cursor = collection_list_cursor_decode(collection_scalar(params, "cursor"), direction)
  local collections, next_cursor = collection_list_query({
    authors = authors,
    hasOrganizationRecord = has_organization_record,
    types = types,
    uris = uris,
    itemUris = item_uris,
    tagUris = tag_uris,
  }, search, limit, cursor, direction)
  local response = { collections = toarray(collections) }
  if next_cursor then response.cursor = next_cursor end
  return response
end

function handle()
  return collection_list_response(false)
end

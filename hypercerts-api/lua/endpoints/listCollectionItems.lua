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

local ITEM_COLLECTION = "org.hypercerts.collection"
local ITEM_ACTIVITY = ACTIVITY
local ITEM_FEATURE = "org.hypercerts.entity.feature"
local ITEM_PROFILE = "app.certified.actor.profile"
local ITEM_ORGANIZATION = "app.certified.actor.organization"
local ITEM_NULL = json.decode("null")

local function collection_items_invalid(message)
  error("InvalidRequest: " .. message, 0)
end

local function collection_items_limit()
  local value = scalar(params, "limit")
  if value == nil then return 25 end
  if not value:match("^%d+$") then collection_items_invalid("limit must be an integer from 1 through 100") end
  local limit = tonumber(value)
  if not limit or limit < 1 or limit > 100 then
    collection_items_invalid("limit must be an integer from 1 through 100")
  end
  return limit
end

local function collection_items_cursor_decode(token, collection_uri)
  if token == nil then return nil end
  if #token == 0 or #token > 8192 or #token % 2 ~= 0 or token:find("[^0-9a-f]") then
    collection_items_invalid("cursor is malformed")
  end
  local decoded = token:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end)
  local ok, value = pcall(json.decode, decoded)
  if not ok or type(value) ~= "table" or value.v ~= 1 or value.u ~= collection_uri
    or type(value.i) ~= "number" or value.i < 1 or value.i % 1 ~= 0 then
    collection_items_invalid("cursor is malformed or belongs to another collection")
  end
  for key in pairs(value) do
    if key ~= "v" and key ~= "u" and key ~= "i" then collection_items_invalid("cursor is malformed") end
  end
  return value
end

local function collection_items_cursor_encode(value)
  return (json.encode(value):gsub(".", function(char)
    return string.format("%02x", string.byte(char))
  end))
end

local function collection_items_query(sql, values)
  if db.backend() ~= "postgres" then
    error("CollectionQueryFailed: collection API requires PostgreSQL", 0)
  end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("CollectionQueryFailed: collection lookup failed", 0)
  end
  return result
end

local function collection_items_key(uri, cid)
  return uri .. "\0" .. cid
end

local function collection_items_bind_exact(collection, references)
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
    local rows = collection_items_query(
      "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
        "FROM happyview_records WHERE collection = $1 AND (" .. table.concat(predicates, " OR ") .. ")",
      values)
    for _, row in ipairs(rows) do
      rows_by_version[collection_items_key(row.uri, row.cid)] = row
    end
  end
  return rows_by_version
end

local function collection_items_load_actor_records(collection, dids)
  if #dids == 0 then return {} end
  local values, placeholders = { collection }, {}
  for _, did in ipairs(dids) do
    values[#values + 1] = did
    placeholders[#placeholders + 1] = "$" .. #values
  end
  local rows = collection_items_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN (" .. table.concat(placeholders, ", ") .. ")",
    values)
  local by_did = {}
  for _, row in ipairs(rows) do by_did[row.did] = row end
  return by_did
end

local function collection_items_row_view(row)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and ITEM_NULL or row.indexed_at,
    did = row.did,
    record = json.decode(row.record),
  }
end

local function collection_items_feature_view(row)
  return {
    ["$type"] = "org.hypercerts.collection.listCollectionItems#featureView",
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and ITEM_NULL or row.indexed_at,
    did = row.did,
    author = { did = row.did },
    record = json.decode(row.record),
  }
end

local function collection_items_hydrate_features(views)
  if #views == 0 then return end
  local dids, seen = {}, {}
  for _, view in ipairs(views) do
    if not seen[view.did] then
      seen[view.did] = true
      dids[#dids + 1] = view.did
    end
  end
  local profiles = collection_items_load_actor_records(ITEM_PROFILE, dids)
  local organizations = collection_items_load_actor_records(ITEM_ORGANIZATION, dids)
  for _, view in ipairs(views) do
    view.author.profile = profiles[view.did] and collection_items_row_view(profiles[view.did]) or ITEM_NULL
    view.author.organization = organizations[view.did] and collection_items_row_view(organizations[view.did]) or ITEM_NULL
  end
end

local function collection_items_summary(row)
  local record = json.decode(row.record)
  local view = {
    ["$type"] = "org.hypercerts.collection.listCollectionItems#collectionSummaryView",
    uri = row.uri,
    cid = row.cid,
    did = row.did,
    title = record.title,
  }
  if record.type ~= nil then view.type = record.type end
  if record.shortDescription ~= nil then view.shortDescription = record.shortDescription end
  return view
end

local function collection_items_resolve(items)
  local references = {
    [ITEM_ACTIVITY] = {},
    [ITEM_COLLECTION] = {},
    [ITEM_FEATURE] = {},
  }
  local seen = { [ITEM_ACTIVITY] = {}, [ITEM_COLLECTION] = {}, [ITEM_FEATURE] = {} }
  for _, item in ipairs(items) do
    local source = item.itemIdentifier
    if type(source) ~= "table" or type(source.uri) ~= "string" or type(source.cid) ~= "string" then
      error("CollectionQueryFailed: indexed collection item has an invalid strong reference", 0)
    end
    local valid, target_collection = valid_record_uri(source.uri)
    if valid and references[target_collection] then
      local key = collection_items_key(source.uri, source.cid)
      if not seen[target_collection][key] then
        seen[target_collection][key] = true
        references[target_collection][#references[target_collection] + 1] = { uri = source.uri, cid = source.cid }
      end
    end
  end

  local activity_rows = collection_items_bind_exact(ITEM_ACTIVITY, references[ITEM_ACTIVITY])
  local collection_rows = collection_items_bind_exact(ITEM_COLLECTION, references[ITEM_COLLECTION])
  local feature_rows = collection_items_bind_exact(ITEM_FEATURE, references[ITEM_FEATURE])

  local activities, activity_views = {}, {}
  for key, row in pairs(activity_rows) do
    local view = activity_view(row)
    activities[key] = view
    activity_views[#activity_views + 1] = view
  end
  hydrate_activity_views(activity_views)
  for _, view in ipairs(activity_views) do
    view["$type"] = "org.hypercerts.claim.getActivity#activityView"
  end

  local features, feature_views = {}, {}
  for key, row in pairs(feature_rows) do
    local view = collection_items_feature_view(row)
    features[key] = view
    feature_views[#feature_views + 1] = view
  end
  collection_items_hydrate_features(feature_views)

  local resolved = {}
  for key, view in pairs(activities) do resolved[key] = view end
  for key, row in pairs(collection_rows) do resolved[key] = collection_items_summary(row) end
  for key, view in pairs(features) do resolved[key] = view end
  return resolved
end

local function collection_items_response()
  keys_only(params, { collection = true, limit = true, cursor = true })
  local collection_uri = scalar(params, "collection")
  local valid, collection = valid_record_uri(collection_uri)
  if not collection_uri or not valid or collection ~= ITEM_COLLECTION then
    collection_items_invalid("collection must be a full org.hypercerts.collection AT-URI with a DID authority")
  end
  local limit = collection_items_limit()
  local cursor = collection_items_cursor_decode(scalar(params, "cursor"), collection_uri)

  local collection_rows = collection_items_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND uri = $2 LIMIT 1",
    { ITEM_COLLECTION, collection_uri })
  if #collection_rows == 0 then error("RecordNotFound: collection record is not indexed", 0) end

  local record = json.decode(collection_rows[1].record)
  local source_items = record.items
  if source_items == nil then source_items = {} end
  if source_items == ITEM_NULL or type(source_items) ~= "table" then
    error("CollectionQueryFailed: indexed collection items are not an array", 0)
  end

  local start = cursor and cursor.i + 1 or 1
  local finish = math.min(start + limit - 1, #source_items)
  local page, page_sources = {}, {}
  for index = start, finish do
    local source = source_items[index]
    if type(source) ~= "table" then
      error("CollectionQueryFailed: indexed collection contains an invalid item", 0)
    end
    local item = {}
    for key, value in pairs(source) do item[key] = value end
    page[#page + 1] = item
    page_sources[#page_sources + 1] = source
  end

  local resolved = collection_items_resolve(page_sources)
  for index, source in ipairs(page_sources) do
    local reference = source.itemIdentifier
    page[index].record = resolved[collection_items_key(reference.uri, reference.cid)] or ITEM_NULL
  end

  local response = { items = toarray(page) }
  if finish < #source_items then
    response.cursor = collection_items_cursor_encode({ v = 1, u = collection_uri, i = finish })
  end
  return response
end

function handle()
  return collection_items_response()
end

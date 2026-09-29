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

local ENTITY_FOLLOW = "app.certified.graph.entityFollow"
local ENTITY_FOLLOW_PROFILE = "app.certified.actor.profile"
local ENTITY_FOLLOW_ORGANIZATION = "app.certified.actor.organization"
local ENTITY_FOLLOW_NULL = json.decode("null")

local function entity_follow_query(sql, values)
  if db.backend() ~= "postgres" then
    error("EntityFollowQueryFailed: entity-follow queries require PostgreSQL", 0)
  end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("EntityFollowQueryFailed: entity-follow lookup failed", 0)
  end
  return result
end

-- Keep malformed publisher timestamps out of casts; preserve the actor-follow fallback order.
local function entity_follow_sort_key()
  local created = "record::jsonb->>'createdAt'"
  local zoned = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$"
  return "CASE WHEN jsonb_typeof(record::jsonb->'createdAt') = 'string' AND " .. created .. " ~ '" .. zoned .. "' AND " .. created .. " !~ '-00:00$' AND pg_input_is_valid(" .. created .. ", 'timestamptz') THEN (" .. created .. ")::timestamptz ELSE COALESCE(indexed_at::timestamptz, created_at::timestamptz) END"
end

local function entity_follow_record_view(row)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and ENTITY_FOLLOW_NULL or row.indexed_at,
    did = row.did,
    record = json.decode(row.record),
  }
end

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

local function entity_follow_lookup(actor, entity_uri)
  local rows = entity_follow_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records CROSS JOIN LATERAL (SELECT " .. entity_follow_sort_key() .. " AS sort_at) sorted WHERE collection = $1 AND did = $2 AND record::jsonb->'subject'->>'uri' = $3 ORDER BY sorted.sort_at ASC, uri ASC LIMIT 1",
    { ENTITY_FOLLOW, actor, entity_uri })
  if #rows == 0 then return ENTITY_FOLLOW_NULL end
  return entity_follow_record_view(rows[1])
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

local function entity_follow_load_actor_records(collection, dids)
  if #dids == 0 then return {} end
  local values, placeholders = { collection }, {}
  for _, did in ipairs(dids) do
    values[#values + 1] = did
    placeholders[#placeholders + 1] = "$" .. #values
  end
  local rows = entity_follow_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN (" .. table.concat(placeholders, ", ") .. ")",
    values)
  local by_did = {}
  for _, row in ipairs(rows) do by_did[row.did] = row end
  return by_did
end

local function entity_follow_hydrate_followers(followers)
  if #followers == 0 then return end
  local dids, seen = {}, {}
  for _, follower in ipairs(followers) do
    if not seen[follower.did] then
      seen[follower.did] = true
      dids[#dids + 1] = follower.did
    end
  end
  local profiles = entity_follow_load_actor_records(ENTITY_FOLLOW_PROFILE, dids)
  local organizations = entity_follow_load_actor_records(ENTITY_FOLLOW_ORGANIZATION, dids)
  for _, follower in ipairs(followers) do
    follower.profile = profiles[follower.did] and entity_follow_record_view(profiles[follower.did]) or ENTITY_FOLLOW_NULL
    follower.organization = organizations[follower.did] and entity_follow_record_view(organizations[follower.did]) or ENTITY_FOLLOW_NULL
  end
end

local function entity_follow_follower_views(rows)
  local followers = {}
  for _, row in ipairs(rows) do
    followers[#followers + 1] = { did = row.did, follow = entity_follow_record_view(row) }
  end
  entity_follow_hydrate_followers(followers)
  return followers
end

local ENTITY_FOLLOW_FEATURE = "org.hypercerts.entity.feature"

local function entity_follow_target_rows(collection, uris)
  if #uris == 0 then return {} end
  local values, placeholders = { collection }, {}
  for _, uri in ipairs(uris) do
    values[#values + 1] = uri
    placeholders[#placeholders + 1] = "$" .. #values
  end
  return entity_follow_query(
    "SELECT DISTINCT ON (uri) uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records WHERE collection = $1 AND uri IN (" .. table.concat(placeholders, ", ") .. ") ORDER BY uri, COALESCE(indexed_at::timestamptz, created_at::timestamptz) DESC, cid DESC",
    values)
end

local function entity_follow_subject_uri(row)
  local record = json.decode(row.record)
  local subject = type(record) == "table" and record.subject or nil
  local uri = type(subject) == "table" and subject.uri or nil
  local valid, collection = valid_record_uri(uri)
  if not valid then error("EntityFollowQueryFailed: indexed follow has an invalid subject URI", 0) end
  return uri, collection
end

local function entity_follow_resolve_entities(rows)
  local supported = {
    [ACTIVITY] = { uris = {}, seen = {} },
    [COLLECTION] = { uris = {}, seen = {} },
    [ENTITY_FOLLOW_FEATURE] = { uris = {}, seen = {} },
  }
  local row_uris = {}
  for _, row in ipairs(rows) do
    local uri, collection = entity_follow_subject_uri(row)
    row_uris[row] = uri
    local group = supported[collection]
    if group and not group.seen[uri] then
      group.seen[uri] = true
      group.uris[#group.uris + 1] = uri
    end
  end

  local views_by_uri = {}
  local activity_views = {}
  for _, row in ipairs(entity_follow_target_rows(ACTIVITY, supported[ACTIVITY].uris)) do
    local view = activity_view(row)
    views_by_uri[row.uri] = view
    activity_views[#activity_views + 1] = view
  end
  hydrate_activity_views(activity_views)
  for _, view in ipairs(activity_views) do
    view["$type"] = "org.hypercerts.claim.getActivity#activityView"
  end

  local collection_views = {}
  for _, row in ipairs(entity_follow_target_rows(COLLECTION, supported[COLLECTION].uris)) do
    local view = collection_view(row)
    views_by_uri[row.uri] = view
    collection_views[#collection_views + 1] = view
  end
  collection_hydrate(collection_views)
  for _, view in ipairs(collection_views) do
    view["$type"] = "org.hypercerts.collection.getCollection#collectionView"
  end

  local feature_views = {}
  for _, row in ipairs(entity_follow_target_rows(ENTITY_FOLLOW_FEATURE, supported[ENTITY_FOLLOW_FEATURE].uris)) do
    local view = collection_items_feature_view(row)
    views_by_uri[row.uri] = view
    feature_views[#feature_views + 1] = view
  end
  collection_items_hydrate_features(feature_views)

  local entities = {}
  for index, row in ipairs(rows) do
    local uri = row_uris[row]
    entities[index] = {
      uri = uri,
      entity = views_by_uri[uri] or ENTITY_FOLLOW_NULL,
      follow = entity_follow_record_view(row),
    }
  end
  return entities
end

local function list_entity_following()
  keys_only(params, { actor = true, sortDirection = true, limit = true, cursor = true })
  local actor = scalar(params, "actor")
  if not actor or not valid_did(actor) then invalid("actor must be a valid DID") end

  local limit = parse_list_limit(params)
  local direction = parse_sort_direction(params)
  local cursor = entity_follow_decode_cursor(scalar(params, "cursor"), direction)
  local rows, next_cursor = entity_follow_query_page("following", actor, limit, cursor, direction)
  local response = { entities = toarray(entity_follow_resolve_entities(rows)) }
  if next_cursor then response.cursor = next_cursor end
  return response
end

function handle()
  return list_entity_following()
end

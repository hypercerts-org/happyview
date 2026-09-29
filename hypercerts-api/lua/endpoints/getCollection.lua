local COLLECTION_PROJECTION_PROFILE = "app.certified.actor.profile"
local COLLECTION_PROJECTION_ORGANIZATION = "app.certified.actor.organization"
local COLLECTION_PROJECTION_LOCATION = "app.certified.location"
local COLLECTION_PROJECTION_TAG = "org.hypercerts.vocab.tag"
local COLLECTION_PROJECTION_NULL = json.decode("null")

local function collection_projection_valid_did(value)
  if type(value) ~= "string" or #value > 2048 then return false end
  local method, specific = value:match("^did:([a-z]+):(.+)$")
  if not method or not specific or specific:sub(-1) == ":" or specific:sub(-1) == "%"
    or value:find("[^%w%.:_%%%-]") then return false end
  return true
end

local function collection_projection_valid_record_key(value)
  return #value >= 1 and #value <= 512 and value ~= "." and value ~= ".."
    and not value:find("[^%w_~%.:%-]")
end

local function collection_projection_valid_record_uri(value)
  if type(value) ~= "string" or #value > 8192 or value:find("[?#]") then return false end
  local authority, collection, rkey = value:match("^at://([^/]+)/([^/]+)/([^/]+)$")
  if not authority or not collection_projection_valid_did(authority)
    or not collection_projection_valid_record_key(rkey) then return false end
  return true, collection, authority
end

local function collection_projection_query(sql, values)
  if db.backend() ~= "postgres" then
    error("CollectionQueryFailed: collection API requires PostgreSQL", 0)
  end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("CollectionQueryFailed: collection lookup failed", 0)
  end
  return result
end

local function collection_projection_record_view(row)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and COLLECTION_PROJECTION_NULL or row.indexed_at,
    did = row.did,
    record = json.decode(row.record),
  }
end

local function collection_projection_ref_key(uri, cid)
  return uri .. "\0" .. cid
end

local function collection_projection_add_unique(values, seen, value)
  if not seen[value] then
    seen[value] = true
    values[#values + 1] = value
  end
end

local function collection_projection_load_actor_records(collection, dids)
  if #dids == 0 then return {} end
  local values, placeholders = { collection }, {}
  for _, did in ipairs(dids) do
    values[#values + 1] = did
    placeholders[#placeholders + 1] = "$" .. #values
  end
  local rows = collection_projection_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN (" .. table.concat(placeholders, ", ") .. ")",
    values)
  local by_did = {}
  for _, row in ipairs(rows) do by_did[row.did] = row end
  return by_did
end

local function collection_projection_load_exact_refs(collection, references)
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
    local rows = collection_projection_query(
      "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
        "FROM happyview_records WHERE collection = $1 AND (" .. table.concat(predicates, " OR ") .. ")",
      values)
    for _, row in ipairs(rows) do
      rows_by_version[collection_projection_ref_key(row.uri, row.cid)] = row
    end
  end
  return rows_by_version
end

local function collection_projection_reference(value, field, expected_collection)
  if type(value) ~= "table" or type(value.uri) ~= "string" or type(value.cid) ~= "string" then
    error("CollectionQueryFailed: indexed collection has an invalid " .. field .. " reference", 0)
  end
  local valid, collection = collection_projection_valid_record_uri(value.uri)
  if not valid then
    error("CollectionQueryFailed: indexed collection has an invalid " .. field .. " reference", 0)
  end
  return {
    uri = value.uri,
    cid = value.cid,
    matches_collection = not expected_collection or collection == expected_collection,
  }
end

local function collection_projection_view(row)
  local record = json.decode(row.record)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and COLLECTION_PROJECTION_NULL or row.indexed_at,
    did = row.did,
    author = { did = row.did },
    record = record,
  }
end

local function collection_projection_hydrate(views)
  if #views == 0 then return end

  local author_dids, seen_authors = {}, {}
  local location_refs, seen_locations = {}, {}
  local tag_refs, seen_tags = {}, {}
  for _, view in ipairs(views) do
    collection_projection_add_unique(author_dids, seen_authors, view.did)
    if view.record.location ~= nil then
      local reference = collection_projection_reference(view.record.location, "location", COLLECTION_PROJECTION_LOCATION)
      if reference.matches_collection then
        local key = collection_projection_ref_key(reference.uri, reference.cid)
        if not seen_locations[key] then
          seen_locations[key] = true
          location_refs[#location_refs + 1] = reference
        end
      end
    end
    if view.record.tags ~= nil then
      if type(view.record.tags) ~= "table" then
        error("CollectionQueryFailed: indexed collection tags are not an array", 0)
      end
      for _, source in ipairs(view.record.tags) do
        local reference = collection_projection_reference(source, "tag", COLLECTION_PROJECTION_TAG)
        if reference.matches_collection then
          local key = collection_projection_ref_key(reference.uri, reference.cid)
          if not seen_tags[key] then
            seen_tags[key] = true
            reference.key = key
            tag_refs[#tag_refs + 1] = reference
          end
        end
      end
    end
  end

  local profiles = collection_projection_load_actor_records(COLLECTION_PROJECTION_PROFILE, author_dids)
  local organizations = collection_projection_load_actor_records(COLLECTION_PROJECTION_ORGANIZATION, author_dids)
  local locations = collection_projection_load_exact_refs(COLLECTION_PROJECTION_LOCATION, location_refs)
  local tags = collection_projection_load_exact_refs(COLLECTION_PROJECTION_TAG, tag_refs)

  for _, view in ipairs(views) do
    view.author.profile = profiles[view.did] and collection_projection_record_view(profiles[view.did]) or COLLECTION_PROJECTION_NULL
    view.author.organization = organizations[view.did] and collection_projection_record_view(organizations[view.did]) or COLLECTION_PROJECTION_NULL

    local source_location = view.record.location
    if source_location ~= nil then
      local key = collection_projection_ref_key(source_location.uri, source_location.cid)
      local row = locations[key]
      view.location = {
        uri = source_location.uri,
        cid = source_location.cid,
        record = row and collection_projection_record_view(row) or COLLECTION_PROJECTION_NULL,
      }
    end

    local source_tags = view.record.tags
    if source_tags ~= nil then
      local projected_tags = {}
      for index, source in ipairs(source_tags) do
        local row = tags[collection_projection_ref_key(source.uri, source.cid)]
        projected_tags[index] = {
          uri = source.uri,
          cid = source.cid,
          record = row and collection_projection_record_view(row) or COLLECTION_PROJECTION_NULL,
        }
      end
      view.tags = toarray(projected_tags)
    end
  end
end

local COLLECTION = "org.hypercerts.collection"

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

local function collection_view(row)
  return collection_projection_view(row)
end

local function collection_hydrate(views)
  return collection_projection_hydrate(views)
end

function handle()
  collection_keys_only(params, { uri = true })
  local uri = collection_scalar(params, "uri")
  local valid, collection = collection_valid_record_uri(uri)
  if not uri or not valid or collection ~= COLLECTION then
    collection_invalid("uri must be a full org.hypercerts.collection AT-URI with a DID authority")
  end

  local rows = collection_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND uri = $2 LIMIT 1",
    { COLLECTION, uri })
  if #rows == 0 then error("RecordNotFound: collection record is not indexed", 0) end

  local view = collection_view(rows[1])
  collection_hydrate({ view })
  return { collection = view }
end

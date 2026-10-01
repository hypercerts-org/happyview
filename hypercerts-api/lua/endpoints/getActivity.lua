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
  if key == "hasOrganizationRecord" and type(value) == "boolean" then return tostring(value) end
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

function handle()
  keys_only(params, { uri = true })
  local uri = scalar(params, "uri")
  local valid, collection = valid_record_uri(uri)
  if not uri or not valid or collection ~= ACTIVITY then
    invalid("uri must be a full org.hypercerts.claim.activity AT-URI with a DID authority")
  end

  local rows = query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND uri = $2 LIMIT 1",
    { ACTIVITY, uri })
  if #rows == 0 then error("RecordNotFound: activity record is not indexed", 0) end

  local view = activity_view(rows[1])
  hydrate_activity_views({ view })
  return { activity = view }
end

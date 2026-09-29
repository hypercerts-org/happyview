local FEATURE_PROJECTION_PROFILE = "app.certified.actor.profile"
local FEATURE_PROJECTION_ORGANIZATION = "app.certified.actor.organization"
local FEATURE_PROJECTION_NULL = json.decode("null")

local function feature_projection_query(sql, values)
  if db.backend() ~= "postgres" then
    error("CollectionQueryFailed: collection API requires PostgreSQL", 0)
  end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("CollectionQueryFailed: collection lookup failed", 0)
  end
  return result
end

local function feature_projection_load_actor_records(collection, dids)
  if #dids == 0 then return {} end
  local values, placeholders = { collection }, {}
  for _, did in ipairs(dids) do
    values[#values + 1] = did
    placeholders[#placeholders + 1] = "$" .. #values
  end
  local rows = feature_projection_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN (" .. table.concat(placeholders, ", ") .. ")",
    values)
  local by_did = {}
  for _, row in ipairs(rows) do by_did[row.did] = row end
  return by_did
end

local function feature_projection_record_view(row)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and FEATURE_PROJECTION_NULL or row.indexed_at,
    did = row.did,
    record = json.decode(row.record),
  }
end

local function feature_projection_view(row)
  return {
    ["$type"] = "org.hypercerts.collection.listCollectionItems#featureView",
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at == nil and FEATURE_PROJECTION_NULL or row.indexed_at,
    did = row.did,
    author = { did = row.did },
    record = json.decode(row.record),
  }
end

local function feature_projection_hydrate(views)
  if #views == 0 then return end
  local dids, seen = {}, {}
  for _, view in ipairs(views) do
    if not seen[view.did] then
      seen[view.did] = true
      dids[#dids + 1] = view.did
    end
  end
  local profiles = feature_projection_load_actor_records(FEATURE_PROJECTION_PROFILE, dids)
  local organizations = feature_projection_load_actor_records(FEATURE_PROJECTION_ORGANIZATION, dids)
  for _, view in ipairs(views) do
    view.author.profile = profiles[view.did] and feature_projection_record_view(profiles[view.did]) or FEATURE_PROJECTION_NULL
    view.author.organization = organizations[view.did] and feature_projection_record_view(organizations[view.did]) or FEATURE_PROJECTION_NULL
  end
end

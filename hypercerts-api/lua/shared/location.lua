local COLLECTION = "app.certified.location"
local PROFILE = "app.certified.actor.profile"
local ORGANIZATION = "app.certified.actor.organization"
local NULL = json.decode("null")

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

local function valid_uri(value)
  if value:find("[?#]") then return false end
  local authority, collection, rkey = value:match("^at://([^/]+)/([^/]+)/([^/]+)$")
  return authority ~= nil and valid_did(authority) and collection == COLLECTION and valid_record_key(rkey)
end

local function query(sql, values)
  local ok, result = pcall(db.raw, sql, values)
  if not ok then error("LocationQueryFailed: location lookup failed", 0) end
  return result
end

local function row_view(row)
  local record = json.decode(row.record)
  return {
    uri = row.uri, cid = row.cid, indexedAt = row.indexed_at, did = row.did,
    record = record,
  }
end

local function hydrate(views)
  if #views == 0 then return end
  local dids, seen = {}, {}
  for _, view in ipairs(views) do
    if not seen[view.did] then seen[view.did] = true; dids[#dids + 1] = view.did end
  end
  local profiles, organizations = {}, {}
  local function load(collection, target)
    if #dids == 0 then return end
    local params, marks = {}, {}
    params[1] = collection
    for _, did in ipairs(dids) do params[#params + 1] = did; marks[#marks + 1] = "$" .. #params end
    local rows = query("SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN (" .. table.concat(marks, ",") .. ")", params)
    for _, row in ipairs(rows) do target[row.did] = row end
  end
  load(PROFILE, profiles)
  load(ORGANIZATION, organizations)
  for _, view in ipairs(views) do
    local profile, organization = profiles[view.did], organizations[view.did]
    local author = { did = view.did, profile = NULL, organization = NULL }
    if profile then author.profile = row_view(profile) end
    if organization then author.organization = row_view(organization) end
    view.author = author
  end
end

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

local PROFILE = "app.certified.actor.profile"

local function invalid(message)
  error("InvalidRequest: " .. message, 0)
end

local function keys_only(values, allowed)
  for key in pairs(values) do
    if not allowed[key] then invalid("unknown query parameter") end
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

local function query(sql, values)
  if db.backend() ~= "postgres" then error("ProfileQueryFailed: profile API requires PostgreSQL", 0) end
  local ok, result = pcall(db.raw, sql, values)
  if not ok then error("ProfileQueryFailed: profile lookup failed", 0) end
  return result
end

local function row_view(row)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at,
    did = row.did,
    record = json.decode(row.record),
  }
end

local function valid_profile_batch_did(value)
  if not valid_did(value) then return false end

  local percent = value:find("%", 1, true)
  while percent do
    local escape = value:sub(percent + 1, percent + 2)
    if #escape ~= 2 or escape:find("[^%x]") then return false end
    percent = value:find("%", percent + 3, true)
  end
  return true
end

local function requested_actors(value)
  if value == nil then invalid("actors is required") end

  local actors = {}
  if type(value) == "string" then
    actors[1] = scalar(params, "actors")
  elseif type(value) == "table" then
    for index = 1, #value do
      if type(value[index]) ~= "string" then invalid("actors entries must be strings") end
      actors[#actors + 1] = value[index]
    end
  else
    invalid("actors must be a string or repeated string parameter")
  end

  if #actors < 1 or #actors > 100 then invalid("actors must contain 1 through 100 DIDs") end

  local unique, seen = {}, {}
  for _, did in ipairs(actors) do
    if not valid_profile_batch_did(did) then invalid("each actors value must be a valid DID") end
    if not seen[did] then
      seen[did] = true
      unique[#unique + 1] = did
    end
  end
  return actors, unique
end

local function get_profiles()
  keys_only(params, { actors = true })
  local actors, unique = requested_actors(params.actors)

  local values, placeholders = { PROFILE }, {}
  for _, did in ipairs(unique) do
    values[#values + 1] = did
    placeholders[#placeholders + 1] = "$" .. #values
  end
  local sql = "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record "
    .. "FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN ("
    .. table.concat(placeholders, ", ") .. ")"
  local rows = query(sql, values)

  local profiles_by_did = {}
  for _, row in ipairs(rows) do profiles_by_did[row.did] = row_view(row) end

  local null = json.decode("null")
  local profiles = {}
  for _, did in ipairs(actors) do
    profiles[#profiles + 1] = { actor = did, profile = profiles_by_did[did] or null }
  end
  return { profiles = toarray(profiles) }
end

function handle()
  return get_profiles()
end

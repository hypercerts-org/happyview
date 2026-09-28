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

local NULL = json.decode("null")

local function record_view(row)
  return {
    uri = row.uri,
    cid = row.cid,
    indexedAt = row.indexed_at,
    did = row.did,
    record = json.decode(row.record),
  }
end

local FOLLOW = "app.certified.graph.follow"

local function query(sql, values)
  if db.backend() ~= "postgres" then error("ActorFollowQueryFailed: actor-follow queries require PostgreSQL", 0) end
  local ok, result = pcall(db.raw, sql, values)
  if not ok then error("ActorFollowQueryFailed: actor-follow lookup failed", 0) end
  return result
end

local function query_follow(actor, subject)
  local rows = query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records WHERE collection = $1 AND did = $2 AND record::jsonb->>'subject' = $3 ORDER BY (record::jsonb->>'createdAt')::timestamptz ASC, uri ASC LIMIT 1",
    { FOLLOW, actor, subject })
  if #rows == 0 then return NULL end
  return record_view(rows[1])
end

local function get_follow()
  keys_only(params, { actor = true, subject = true })
  local actor = scalar(params, "actor")
  local subject = scalar(params, "subject")
  if not actor or not valid_did(actor) then invalid("actor must be a valid DID") end
  if not subject or not valid_did(subject) then invalid("subject must be a valid DID") end
  return { follow = query_follow(actor, subject) }
end

function handle()
  return get_follow()
end

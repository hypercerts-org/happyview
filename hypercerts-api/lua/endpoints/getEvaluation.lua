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

local PROFILE = "app.certified.actor.profile"
local ORGANIZATION = "app.certified.actor.organization"

local function hydrate_actor_views(actors, run_query)
  if #actors == 0 then return end
  local dids, seen = {}, {}
  for _, actor in ipairs(actors) do
    if not seen[actor.did] then
      seen[actor.did] = true
      dids[#dids + 1] = actor.did
    end
  end
  local profiles, organizations = {}, {}
  local function load(collection, target)
    local params, marks = { collection }, {}
    for _, did in ipairs(dids) do
      params[#params + 1] = did
      marks[#marks + 1] = "$" .. #params
    end
    local rows = run_query("SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN (" .. table.concat(marks, ",") .. ")", params)
    for _, row in ipairs(rows) do target[row.did] = row end
  end
  load(PROFILE, profiles)
  load(ORGANIZATION, organizations)
  for _, actor in ipairs(actors) do
    actor.profile = profiles[actor.did] and record_view(profiles[actor.did]) or NULL
    actor.organization = organizations[actor.did] and record_view(organizations[actor.did]) or NULL
  end
end

local EVALUATION = "org.hypercerts.context.evaluation"
local EVALUATOR_HYDRATION_LIMIT = 100

local function evaluation_query(sql, values)
  if db.backend() ~= "postgres" then
    error("EvaluationQueryFailed: evaluation API requires PostgreSQL", 0)
  end
  local ok, result = pcall(db.raw, sql, values)
  if not ok or type(result) ~= "table" then
    error("EvaluationQueryFailed: evaluation lookup failed", 0)
  end
  return result
end

local function evaluation_view(row, skip_invalid)
  local view = record_view(row)
  if type(view.record) ~= "table" or type(view.record.evaluators) ~= "table" then
    if skip_invalid then return nil end
    error("EvaluationQueryFailed: indexed evaluation has no evaluator array", 0)
  end
  if #view.record.evaluators > 1000 then
    if skip_invalid then return nil end
    error("EvaluationQueryFailed: indexed evaluation exceeds the evaluator limit", 0)
  end
  for _, evaluator in ipairs(view.record.evaluators) do
    if type(evaluator) ~= "table" or not valid_did(evaluator.did) then
      if skip_invalid then return nil end
      error("EvaluationQueryFailed: indexed evaluation contains an invalid evaluator DID", 0)
    end
  end
  view.author = { did = row.did }
  return view
end

local function hydrate_evaluation_views(views)
  local actors = {}
  local evaluator_projections = {}
  local evaluator_actors = {}

  for view_index, view in ipairs(views) do
    actors[#actors + 1] = view.author
    local projections, hydrated_actors = {}, {}
    for position, source in ipairs(view.record.evaluators) do
      if type(source) ~= "table" or not valid_did(source.did) then
        error("EvaluationQueryFailed: indexed evaluation contains an invalid evaluator DID", 0)
      end
      local evaluator = {}
      for key, value in pairs(source) do evaluator[key] = value end
      if position <= EVALUATOR_HYDRATION_LIMIT then
        evaluator.hydrationStatus = "hydrated"
        local actor = { did = source.did }
        actors[#actors + 1] = actor
        hydrated_actors[position] = actor
      else
        evaluator.hydrationStatus = "omitted"
        evaluator.profile = nil
        evaluator.organization = nil
      end
      projections[position] = evaluator
    end
    evaluator_projections[view_index] = projections
    evaluator_actors[view_index] = hydrated_actors
  end

  hydrate_actor_views(actors, evaluation_query)

  for view_index, view in ipairs(views) do
    local projections = evaluator_projections[view_index]
    for position, actor in pairs(evaluator_actors[view_index]) do
      projections[position].profile = actor.profile
      projections[position].organization = actor.organization
    end
    view.evaluators = toarray(projections)
  end
end

function handle()
  keys_only(params, { uri = true })
  local uri = scalar(params, "uri")
  local valid, collection = valid_record_uri(uri)
  if not uri or not valid or collection ~= EVALUATION then
    invalid("uri must be a full org.hypercerts.context.evaluation AT-URI with a DID authority")
  end

  local rows = evaluation_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND uri = $2 LIMIT 1",
    { EVALUATION, uri })
  if #rows == 0 then error("RecordNotFound: evaluation record is not indexed", 0) end

  local view = evaluation_view(rows[1])
  hydrate_evaluation_views({ view })
  return { evaluation = view }
end

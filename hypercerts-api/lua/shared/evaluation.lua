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

local function evaluation_view(row)
  local view = record_view(row)
  if type(view.record) ~= "table" or type(view.record.evaluators) ~= "table" then
    error("EvaluationQueryFailed: indexed evaluation has no evaluator array", 0)
  end
  if #view.record.evaluators > 1000 then
    error("EvaluationQueryFailed: indexed evaluation exceeds the evaluator limit", 0)
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

local function list_entity_following_keys_only(values, allowed)
  for key in pairs(values) do
    if not allowed[key] then invalid("unknown query parameter: " .. key) end
  end
  keys_only(values, allowed)
end

local function list_entity_following()
  list_entity_following_keys_only(params, { actor = true, sortDirection = true, limit = true, cursor = true })
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

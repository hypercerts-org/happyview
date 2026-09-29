local function list_entity_followers()
  keys_only(params, { entity = true, sortDirection = true, limit = true, cursor = true })
  local entity_uri = scalar(params, "entity")
  if not entity_uri or #entity_uri > 8192 or not valid_record_uri(entity_uri) then
    invalid("entity must be a full DID-authority AT-URI")
  end

  local limit = parse_list_limit(params)
  local direction = parse_sort_direction(params)
  local cursor = entity_follow_decode_cursor(scalar(params, "cursor"), direction)
  local rows, next_cursor = entity_follow_query_page("followers", entity_uri, limit, cursor, direction)
  local response = { followers = toarray(entity_follow_follower_views(rows)) }
  if next_cursor then response.cursor = next_cursor end
  return response
end

function handle()
  return list_entity_followers()
end

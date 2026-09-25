local function list_locations()
  keys_only(params, { authors = true, uris = true, locationTypes = true, search = true, limit = true, cursor = true, sortDirection = true })
  local authors = array(params, "authors", valid_did, "valid DIDs")
  local uris = array(params, "uris", valid_uri, "full app.certified.location AT-URIs with DID authorities")
  local types = array(params, "locationTypes", nil, nil, 20)
  local search = scalar(params, "search")
  if search and #search > 2000 then invalid("search must be at most 2000 UTF-8 bytes") end
  if search then search = search:match("^%s*(.-)%s*$") end
  local limit_value = scalar(params, "limit")
  if limit_value and not limit_value:match("^%d+$") then invalid("limit must be an integer from 1 through 100") end
  local limit = limit_value and tonumber(limit_value) or 25
  if not limit or limit % 1 ~= 0 or limit < 1 or limit > 100 then invalid("limit must be an integer from 1 through 100") end
  local direction = scalar(params, "sortDirection") or "desc"
  if direction ~= "asc" and direction ~= "desc" then invalid("sortDirection must be 'asc' or 'desc'") end
  local cursor = cursor_decode(scalar(params, "cursor"), direction)
  local views, next_cursor = query_locations({ authors = authors, uris = uris, locationTypes = types, search = search }, limit, cursor, direction)
  local response = { locations = toarray(views) }
  if next_cursor then response.cursor = next_cursor end
  return response
end

function handle()
  return list_locations()
end

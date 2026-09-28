local COLLECTION = "app.certified.location"

local function valid_location_uri(value)
  local valid, collection = valid_record_uri(value)
  return valid and collection == COLLECTION
end

local function query(sql, values)
  local ok, result = pcall(db.raw, sql, values)
  if not ok then error("LocationQueryFailed: location lookup failed", 0) end
  return result
end

local function hydrate(views)
  local authors = {}
  for _, view in ipairs(views) do
    local author = { did = view.did }
    view.author = author
    authors[#authors + 1] = author
  end
  hydrate_actor_views(authors, query)
end

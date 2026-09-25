local function get_location()
  keys_only(params, { uri = true })
  local uri = scalar(params, "uri")
  if not uri or not valid_uri(uri) then invalid("uri must be a full app.certified.location AT-URI with a DID authority") end
  local views = query_locations({}, 1, nil, "desc", uri)
  if #views == 0 then error("RecordNotFound: location record is not indexed", 0) end
  return { location = views[1] }
end

function handle()
  return get_location()
end

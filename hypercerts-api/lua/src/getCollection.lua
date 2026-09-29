function handle()
  collection_keys_only(params, { uri = true })
  local uri = collection_scalar(params, "uri")
  local valid, collection = collection_valid_record_uri(uri)
  if not uri or not valid or collection ~= COLLECTION then
    collection_invalid("uri must be a full org.hypercerts.collection AT-URI with a DID authority")
  end

  local rows = collection_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND uri = $2 LIMIT 1",
    { COLLECTION, uri })
  if #rows == 0 then error("RecordNotFound: collection record is not indexed", 0) end

  local view = collection_view(rows[1])
  collection_hydrate({ view })
  return { collection = view }
end

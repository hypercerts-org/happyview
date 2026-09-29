function handle()
  keys_only(params, { uri = true })
  local uri = scalar(params, "uri")
  local valid, collection = valid_record_uri(uri)
  if not uri or not valid or collection ~= ACTIVITY then
    invalid("uri must be a full org.hypercerts.claim.activity AT-URI with a DID authority")
  end

  local rows = query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND uri = $2 LIMIT 1",
    { ACTIVITY, uri })
  if #rows == 0 then error("RecordNotFound: activity record is not indexed", 0) end

  local view = activity_view(rows[1])
  hydrate_activity_views({ view })
  return { activity = view }
end

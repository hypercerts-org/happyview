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

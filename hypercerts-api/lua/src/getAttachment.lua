function handle()
  keys_only(params, { uri = true })
  local uri = scalar(params, "uri")
  if not uri or not valid_attachment_uri(uri) then
    invalid("uri must be a full org.hypercerts.context.attachment AT-URI with a DID authority")
  end

  local rows = attachment_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND uri = $2 LIMIT 1",
    { ATTACHMENT_COLLECTION, uri })
  if #rows == 0 then error("RecordNotFound: attachment record is not indexed", 0) end

  local view = attachment_view(rows[1])
  hydrate_attachment_views({ view })
  return { attachment = view }
end

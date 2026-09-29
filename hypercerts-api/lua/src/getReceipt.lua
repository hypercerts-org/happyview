function handle()
  keys_only(params, { uri = true })
  local uri = scalar(params, "uri")
  local valid, collection = valid_record_uri(uri)
  if not uri or not valid or collection ~= RECEIPT then
    invalid("uri must be a full org.hypercerts.funding.receipt AT-URI with a DID authority")
  end

  local rows = receipt_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND uri = $2 LIMIT 1",
    { RECEIPT, uri })
  if #rows == 0 then error("RecordNotFound: funding receipt is not indexed", 0) end

  local view = funding_receipt_view(rows[1])
  hydrate_funding_receipt_views({ view })
  return { receipt = view }
end

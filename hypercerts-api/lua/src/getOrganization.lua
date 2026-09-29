function handle()
  keys_only(params, { actor = true })
  local actor = scalar(params, "actor")
  if not actor or not valid_did(actor) then invalid("actor must be a valid DID") end

  local rows = query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record " ..
      "FROM happyview_records WHERE collection = $1 AND did = $2 AND rkey = 'self' LIMIT 1",
    { ORGANIZATION, actor })
  if #rows == 0 then error("RecordNotFound: organization sidecar is not indexed", 0) end

  local result = organization_actor_view(rows[1])
  hydrate_organization_actors({ result })
  return { actor = result }
end

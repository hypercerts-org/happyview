local function query_follow(actor, subject)
  local rows = query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records WHERE collection = $1 AND did = $2 AND record::jsonb->>'subject' = $3 ORDER BY (record::jsonb->>'createdAt')::timestamptz ASC, uri ASC LIMIT 1",
    { FOLLOW, actor, subject })
  if #rows == 0 then return NULL end
  return row_view(rows[1])
end

local function get_follow()
  keys_only(params, { actor = true, subject = true })
  local actor = scalar(params, "actor")
  local subject = scalar(params, "subject")
  if not actor or not valid_did(actor) then invalid("actor must be a valid DID") end
  if not subject or not valid_did(subject) then invalid("subject must be a valid DID") end
  return { follow = query_follow(actor, subject) }
end

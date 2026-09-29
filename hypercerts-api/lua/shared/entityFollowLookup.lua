local function entity_follow_lookup(actor, entity_uri)
  local rows = entity_follow_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records CROSS JOIN LATERAL (SELECT " .. entity_follow_sort_key() .. " AS sort_at) sorted WHERE collection = $1 AND did = $2 AND record::jsonb->'subject'->>'uri' = $3 ORDER BY sorted.sort_at ASC, uri ASC LIMIT 1",
    { ENTITY_FOLLOW, actor, entity_uri })
  if #rows == 0 then return ENTITY_FOLLOW_NULL end
  return entity_follow_record_view(rows[1])
end

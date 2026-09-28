local FOLLOW = "app.certified.graph.follow"

-- Guard the cast inside CASE; a WHERE filter cannot protect it from planner reordering.
local function follow_sort_key()
  local created = "record::jsonb->>'createdAt'"
  local timestamp_pattern = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$"
  return "CASE WHEN jsonb_typeof(record::jsonb->'createdAt') = 'string' AND " .. created .. " ~ '" .. timestamp_pattern .. "' AND " .. created .. " !~ '-00:00$' AND pg_input_is_valid(" .. created .. ", 'timestamptz') THEN (" .. created .. ")::timestamptz ELSE COALESCE(indexed_at::timestamptz, created_at::timestamptz) END"
end

local function query(sql, values)
  if db.backend() ~= "postgres" then error("ActorFollowQueryFailed: actor-follow queries require PostgreSQL", 0) end
  local ok, result = pcall(db.raw, sql, values)
  if not ok then error("ActorFollowQueryFailed: actor-follow lookup failed", 0) end
  return result
end

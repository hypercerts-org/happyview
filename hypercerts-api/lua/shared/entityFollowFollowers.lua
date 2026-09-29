local ENTITY_FOLLOW_FOLLOWER_PROFILE = "app.certified.actor.profile"
local ENTITY_FOLLOW_FOLLOWER_ORGANIZATION = "app.certified.actor.organization"

local function entity_follow_load_actor_records(collection, dids)
  if #dids == 0 then return {} end
  local values, placeholders = { collection }, {}
  for _, did in ipairs(dids) do
    values[#values + 1] = did
    placeholders[#placeholders + 1] = "$" .. #values
  end
  local rows = entity_follow_query(
    "SELECT uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records WHERE collection = $1 AND rkey = 'self' AND did IN (" .. table.concat(placeholders, ", ") .. ")",
    values)
  local by_did = {}
  for _, row in ipairs(rows) do by_did[row.did] = row end
  return by_did
end

local function entity_follow_hydrate_followers(followers)
  if #followers == 0 then return end
  local dids, seen = {}, {}
  for _, follower in ipairs(followers) do
    if not seen[follower.did] then
      seen[follower.did] = true
      dids[#dids + 1] = follower.did
    end
  end
  local profiles = entity_follow_load_actor_records(ENTITY_FOLLOW_FOLLOWER_PROFILE, dids)
  local organizations = entity_follow_load_actor_records(ENTITY_FOLLOW_FOLLOWER_ORGANIZATION, dids)
  for _, follower in ipairs(followers) do
    follower.profile = profiles[follower.did] and entity_follow_record_view(profiles[follower.did]) or ENTITY_FOLLOW_NULL
    follower.organization = organizations[follower.did] and entity_follow_record_view(organizations[follower.did]) or ENTITY_FOLLOW_NULL
  end
end

local function entity_follow_follower_views(rows)
  local followers = {}
  for _, row in ipairs(rows) do
    followers[#followers + 1] = { did = row.did, follow = entity_follow_record_view(row) }
  end
  entity_follow_hydrate_followers(followers)
  return followers
end

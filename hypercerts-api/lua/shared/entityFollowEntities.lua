local ENTITY_FOLLOW_FEATURE = "org.hypercerts.entity.feature"

local function entity_follow_target_rows(collection, uris)
  if #uris == 0 then return {} end
  local values, placeholders = { collection }, {}
  for _, uri in ipairs(uris) do
    values[#values + 1] = uri
    placeholders[#placeholders + 1] = "$" .. #values
  end
  return entity_follow_query(
    "SELECT DISTINCT ON (uri) uri, did, cid, indexed_at::text AS indexed_at, record::text AS record FROM happyview_records WHERE collection = $1 AND uri IN (" .. table.concat(placeholders, ", ") .. ") ORDER BY uri, COALESCE(indexed_at::timestamptz, created_at::timestamptz) DESC, cid DESC",
    values)
end

local function entity_follow_subject_uri(row)
  local record = json.decode(row.record)
  local subject = type(record) == "table" and record.subject or nil
  local uri = type(subject) == "table" and subject.uri or nil
  local valid, collection = valid_record_uri(uri)
  if not valid then error("EntityFollowQueryFailed: indexed follow has an invalid subject URI", 0) end
  return uri, collection
end

local function entity_follow_resolve_entities(rows)
  local supported = {
    [ACTIVITY] = { uris = {}, seen = {} },
    [COLLECTION] = { uris = {}, seen = {} },
    [ENTITY_FOLLOW_FEATURE] = { uris = {}, seen = {} },
  }
  local row_uris = {}
  for _, row in ipairs(rows) do
    local uri, collection = entity_follow_subject_uri(row)
    row_uris[row] = uri
    local group = supported[collection]
    if group and not group.seen[uri] then
      group.seen[uri] = true
      group.uris[#group.uris + 1] = uri
    end
  end

  local views_by_uri = {}
  local activity_views = {}
  for _, row in ipairs(entity_follow_target_rows(ACTIVITY, supported[ACTIVITY].uris)) do
    local view = activity_view(row)
    views_by_uri[row.uri] = view
    activity_views[#activity_views + 1] = view
  end
  hydrate_activity_views(activity_views)
  for _, view in ipairs(activity_views) do
    view["$type"] = "org.hypercerts.claim.getActivity#activityView"
  end

  local collection_views = {}
  for _, row in ipairs(entity_follow_target_rows(COLLECTION, supported[COLLECTION].uris)) do
    local view = collection_view(row)
    views_by_uri[row.uri] = view
    collection_views[#collection_views + 1] = view
  end
  collection_hydrate(collection_views)
  for _, view in ipairs(collection_views) do
    view["$type"] = "org.hypercerts.collection.getCollection#collectionView"
  end

  local feature_views = {}
  for _, row in ipairs(entity_follow_target_rows(ENTITY_FOLLOW_FEATURE, supported[ENTITY_FOLLOW_FEATURE].uris)) do
    local view = collection_items_feature_view(row)
    views_by_uri[row.uri] = view
    feature_views[#feature_views + 1] = view
  end
  collection_items_hydrate_features(feature_views)

  local entities = {}
  for index, row in ipairs(rows) do
    local uri = row_uris[row]
    entities[index] = {
      uri = uri,
      entity = views_by_uri[uri] or ENTITY_FOLLOW_NULL,
      follow = entity_follow_record_view(row),
    }
  end
  return entities
end

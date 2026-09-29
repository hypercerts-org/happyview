local function get_entity_follow()
  keys_only(params, { actor = true, entity = true })
  local actor = scalar(params, "actor")
  local entity_uri = scalar(params, "entity")
  if not actor or not valid_did(actor) then invalid("actor must be a valid DID") end
  if not entity_uri or #entity_uri > 8192 or not valid_record_uri(entity_uri) then
    invalid("entity must be a full DID-authority AT-URI")
  end
  return { follow = entity_follow_lookup(actor, entity_uri) }
end

function handle()
  return get_entity_follow()
end

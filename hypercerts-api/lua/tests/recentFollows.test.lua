local FOLLOW = "app.certified.graph.follow"
local ENTITY_FOLLOW = "app.certified.graph.entityFollow"

local publisher = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"
local target = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb"
local account_record = {
  ["$type"] = FOLLOW,
  subject = target,
  relationship = "same-relationship",
  createdAt = "2025-01-02T03:04:05Z",
}
local entity_record = {
  ["$type"] = ENTITY_FOLLOW,
  subject = target,
  relationship = "same-relationship",
  createdAt = "2025-01-02T03:04:05Z",
}
local decoded_records = {
  ["account-record"] = account_record,
  ["entity-record"] = entity_record,
  ["late-account-record"] = {
    ["$type"] = FOLLOW,
    subject = target,
    relationship = "same-relationship",
    createdAt = "2025-01-01T00:00:00Z",
  },
  ["local-record"] = account_record,
}
local encoded_cursor
local json_null = {}
json = {
  decode = function(value)
    if value == "null" then return json_null end
    local record = decoded_records[value]
    if record then return record end
    if value == "{}" and encoded_cursor then return encoded_cursor end
    error("unexpected JSON decode: " .. tostring(value))
  end,
  encode = function(value)
    encoded_cursor = value
    return "{}"
  end,
}
toarray = function(value) return value end
local rows = {
  {
    uri = "at://" .. publisher .. "/" .. ENTITY_FOLLOW .. "/entity-rkey",
    did = publisher,
    cid = "bafy-entity",
    indexed_at = nil,
    record = "entity-record",
    sort_timestamp = "2025-01-02T03:04:05.000000Z",
  },
  {
    uri = "at://" .. publisher .. "/" .. FOLLOW .. "/account-rkey",
    did = publisher,
    cid = "bafy-account",
    indexed_at = "2025-01-02T03:05:00.000Z",
    record = "account-record",
    sort_timestamp = "2025-01-02T03:04:05.000000Z",
  },
  {
    uri = "at://" .. publisher .. "/" .. FOLLOW .. "/local-only",
    did = publisher,
    cid = "",
    indexed_at = nil,
    record = "local-record",
    sort_timestamp = "2025-01-02T03:04:05.000000Z",
  },
}
local response_rows = rows
local calls = {}
db = {
  backend = function() return "postgres" end,
  raw = function(sql, values)
    calls[#calls + 1] = { sql = sql, values = values }
    local indexed_rows = {}
    for _, row in ipairs(response_rows) do
      if row.cid ~= "" then indexed_rows[#indexed_rows + 1] = row end
    end
    return indexed_rows
  end,
}

params = {}
local function source(path)
  local file = assert(io.open(path, "r"))
  local content = file:read("*a")
  file:close()
  return content
end
local handler = table.concat({
  source("lua/shared/query.lua"),
  source("lua/shared/recentFollows.lua"),
  source("lua/src/listRecentFollows.lua"),
}, "\n\n")
assert(load(handler, "recentFollows.test"))()

local function invoke(request_params)
  params = request_params
  return pcall(handle)
end

local invalid_cases = {
  { label = "unknown parameter", params = { unexpected = "x" } },
  { label = "repeated scalar", params = { limit = { "1", "2" } } },
  { label = "repeated before", params = { before = { "2025-01-03T00:00:00Z", "2025-01-04T00:00:00Z" } } },
  { label = "repeated cursor", params = { cursor = { "7b7d", "7b7d" } } },
  { label = "invalid limit", params = { limit = "0" } },
  { label = "malformed before", params = { before = "2025-02-30T00:00:00Z" } },
  { label = "malformed cursor", params = { cursor = "not-hex" } },
  { label = "malformed cursor payload", params = { cursor = "7b7d" } },
}

for _, case in ipairs(invalid_cases) do
  local calls_before = #calls
  local ok, result = invoke(case.params)
  assert(not ok, case.label .. " should be rejected")
  assert(tostring(result):find("InvalidRequest:", 1, true), case.label .. " should report InvalidRequest")
  assert(#calls == calls_before, case.label .. " must be rejected before querying")
end

local ok, result = invoke({})
assert(ok, tostring(result))
assert(calls[1].sql:find("cid <> ''", 1, true), "SQL excludes save_local rows with empty CIDs")
assert(type(result.follows) == "table" and #result.follows == 2, "both network follow records survive while the local-only fixture is excluded")
assert(result.follows[1].indexedAt == json_null, "NULL indexed_at is emitted as explicit JSON null")
assert(result.follows[1].uri == rows[1].uri and result.follows[2].uri == rows[2].uri,
  "response preserves the URI order returned by the database")
assert(result.follows[1].record["$type"] == ENTITY_FOLLOW)
assert(result.follows[2].record["$type"] == FOLLOW)
assert(result.follows[1].record.relationship == result.follows[2].record.relationship,
  "distinct records for the same relationship are not collapsed")
assert(result.follows[1].did == publisher and result.follows[2].did == publisher)
assert(result.follows[1].cid == "bafy-entity" and result.follows[2].cid == "bafy-account")
assert(#calls == 1, "valid query calls db.raw once")
assert(calls[1].values[1] == FOLLOW, "query binds the account-follow collection")
assert(calls[1].values[2] == ENTITY_FOLLOW, "query binds the entity-follow collection")

local before = "2025-01-03T00:00:00Z"
local late_row = {
  uri = "at://" .. publisher .. "/" .. FOLLOW .. "/late-rkey",
  did = publisher,
  cid = "bafy-late",
  indexed_at = "2025-01-03T00:00:00.000Z",
  record = "late-account-record",
  sort_timestamp = "2025-01-01T00:00:00.000000Z",
}
local three_rows = { rows[1], rows[2], late_row }
response_rows = three_rows
local first_ok, first_page = invoke({ limit = "2", before = before })
assert(first_ok, tostring(first_page))
assert(#first_page.follows == 2 and first_page.follows[1].uri == rows[1].uri and first_page.follows[2].uri == rows[2].uri,
  "lookahead row is omitted from the first page")
assert(first_page.cursor, "lookahead row causes a next-page cursor")
assert(encoded_cursor.t == rows[2].sort_timestamp and encoded_cursor.u == rows[2].uri and encoded_cursor.b == before,
  "cursor records the last returned timestamp, URI, and before value")
assert(calls[2].values[3] == before and calls[2].values[4] == 3,
  "first-page query binds before and limit-plus-one")
assert(calls[2].sql:find("sort_at < $3::timestamptz", 1, true), "before predicate is exclusive")

response_rows = { late_row }
local second_ok, second_page = invoke({ limit = "2", before = before, cursor = first_page.cursor })
assert(second_ok, tostring(second_page))
assert(#second_page.follows == 1 and second_page.follows[1].uri == late_row.uri)
assert(calls[3].values[3] == before, "next page binds the unchanged before value")
assert(calls[3].values[4] == rows[2].sort_timestamp and calls[3].values[5] == rows[2].uri,
  "next page binds the cursor timestamp and URI tuple")
assert(calls[3].values[6] == 3, "next page keeps limit-plus-one lookahead")
assert(calls[3].sql:find("sort_at < $3::timestamptz", 1, true))
assert(calls[3].sql:find("(sort_at, uri) < ($4::timestamptz, $5)", 1, true),
  "cursor uses an exclusive descending keyset tuple")

local calls_before_changed_bound = #calls
local changed_ok, changed_error = invoke({
  limit = "2",
  before = "2025-01-04T00:00:00Z",
  cursor = first_page.cursor,
})
assert(not changed_ok and tostring(changed_error):find("InvalidRequest:", 1, true),
  "changing before rejects the cursor")
assert(#calls == calls_before_changed_bound, "changed before is rejected before db.raw")
print("recentFollows offline Lua tests passed")

std = "lua54"
globals = { "handle" }
read_globals = { "db", "json", "params", "toarray" }
not_globals = {
  "io", "debug", "package", "require", "dofile", "loadfile", "load", "collectgarbage",
  "os.execute", "os.exit", "os.getenv", "os.remove", "os.rename", "os.setlocale", "os.tmpname",
}
unused_args = true
-- Generated SQL expressions can be long; keep Luacheck focused on code issues.
max_line_length = false

-- Echo Dependency Resolver D1 Schema
-- Tracks service dependencies, detects circular refs, validates compatibility

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL DEFAULT '1.0.0',
  status TEXT NOT NULL DEFAULT 'active',
  endpoint_url TEXT,
  binding_name TEXT,
  dependencies TEXT NOT NULL DEFAULT '[]',
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_checked TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dependency_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_service TEXT NOT NULL,
  target_service TEXT NOT NULL,
  binding_name TEXT,
  required INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_service, target_service, binding_name)
);

CREATE TABLE IF NOT EXISTS compatibility_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_name TEXT NOT NULL,
  min_version TEXT,
  max_version TEXT,
  breaking_changes TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dependency_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_type TEXT NOT NULL,
  status TEXT NOT NULL,
  details TEXT DEFAULT '{}',
  circular_deps TEXT DEFAULT '[]',
  missing_deps TEXT DEFAULT '[]',
  version_conflicts TEXT DEFAULT '[]',
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_services_name ON services(name);
CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);
CREATE INDEX IF NOT EXISTS idx_edges_source ON dependency_edges(source_service);
CREATE INDEX IF NOT EXISTS idx_edges_target ON dependency_edges(target_service);
CREATE INDEX IF NOT EXISTS idx_checks_type ON dependency_checks(check_type);
CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON dependency_checks(checked_at);
CREATE INDEX IF NOT EXISTS idx_compat_service ON compatibility_rules(service_name);

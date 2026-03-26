import { Hono } from 'hono';
import { cors } from 'hono/cors';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  SHARED_BRAIN: Fetcher;
  ALERT_ROUTER: Fetcher;
}

interface ServiceRow {
  id: number;
  name: string;
  version: string;
  status: string;
  endpoint_url: string | null;
  binding_name: string | null;
  dependencies: string;
  health_status: string;
  last_checked: string | null;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: number;
  source_service: string;
  target_service: string;
  binding_name: string | null;
  required: number;
  created_at: string;
}

interface CompatRow {
  id: number;
  service_name: string;
  min_version: string | null;
  max_version: string | null;
  breaking_changes: string;
  created_at: string;
}

interface CheckRow {
  id: number;
  check_type: string;
  status: string;
  details: string;
  circular_deps: string;
  missing_deps: string;
  version_conflicts: string;
  checked_at: string;
}

interface ServiceInput {
  name: string;
  version?: string;
  endpoint_url?: string;
  binding_name?: string;
  dependencies?: string[];
  status?: string;
}

interface WranglerBinding {
  binding: string;
  service: string;
}

// ─── Logger ──────────────────────────────────────────────────────────────────

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'info', msg, ts: new Date().toISOString(), ...data })),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'warn', msg, ts: new Date().toISOString(), ...data })),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'error', msg, ts: new Date().toISOString(), ...data })),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const API_KEY = 'echo-omega-prime-forge-x-2026';
const CACHE_TTL = 600;
const START_TIME = Date.now();

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function apiResponse(success: boolean, data?: unknown, error?: string, status = 200): Response {
  return jsonResponse({ success, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}), timestamp: new Date().toISOString() }, status);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function isVersionInRange(version: string, min: string | null, max: string | null): boolean {
  if (min && compareVersions(version, min) < 0) return false;
  if (max && compareVersions(version, max) > 0) return false;
  return true;
}

// ─── Graph Algorithms ────────────────────────────────────────────────────────

function detectCircularDeps(edges: EdgeRow[]): string[][] {
  const adj = new Map<string, string[]>();
  const allNodes = new Set<string>();

  for (const edge of edges) {
    allNodes.add(edge.source_service);
    allNodes.add(edge.target_service);
    const neighbors = adj.get(edge.source_service) ?? [];
    neighbors.push(edge.target_service);
    adj.set(edge.source_service, neighbors);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    visited.add(node);
    recStack.add(node);
    path.push(node);

    const neighbors = adj.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (recStack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart !== -1) {
          cycles.push([...path.slice(cycleStart), neighbor]);
        }
      }
    }

    path.pop();
    recStack.delete(node);
  }

  for (const node of allNodes) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

function getTransitiveDeps(edges: EdgeRow[], serviceName: string): string[] {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    const neighbors = adj.get(edge.source_service) ?? [];
    neighbors.push(edge.target_service);
    adj.set(edge.source_service, neighbors);
  }

  const visited = new Set<string>();
  const queue = [serviceName];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adj.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return Array.from(visited);
}

function getTransitiveDependents(edges: EdgeRow[], serviceName: string): string[] {
  const reverseAdj = new Map<string, string[]>();
  for (const edge of edges) {
    const neighbors = reverseAdj.get(edge.target_service) ?? [];
    neighbors.push(edge.source_service);
    reverseAdj.set(edge.target_service, neighbors);
  }

  const visited = new Set<string>();
  const queue = [serviceName];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = reverseAdj.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return Array.from(visited);
}

function buildAdjacencyList(edges: EdgeRow[]): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const edge of edges) {
    if (!adj[edge.source_service]) {
      adj[edge.source_service] = [];
    }
    adj[edge.source_service]!.push(edge.target_service);
    if (!adj[edge.target_service]) {
      adj[edge.target_service] = [];
    }
  }
  return adj;
}

function buildDotGraph(edges: EdgeRow[], services: ServiceRow[]): string {
  const lines: string[] = ['digraph EchoDependencies {', '  rankdir=LR;', '  node [shape=box, style=filled, fillcolor="#e8f4fd"];', ''];

  const serviceMap = new Map<string, ServiceRow>();
  for (const s of services) {
    serviceMap.set(s.name, s);
  }

  for (const s of services) {
    const color = s.health_status === 'healthy' ? '#c8e6c9' : s.health_status === 'unhealthy' ? '#ffcdd2' : '#e8f4fd';
    const label = `${s.name}\\nv${s.version}\\n[${s.status}]`;
    lines.push(`  "${s.name}" [label="${label}", fillcolor="${color}"];`);
  }

  lines.push('');

  for (const edge of edges) {
    const style = edge.required ? 'solid' : 'dashed';
    const label = edge.binding_name ? ` [label="${edge.binding_name}", style=${style}]` : ` [style=${style}]`;
    lines.push(`  "${edge.source_service}" -> "${edge.target_service}"${label};`);
  }

  lines.push('}');
  return lines.join('\n');
}

// ─── Sync edges helper ──────────────────────────────────────────────────────

async function syncEdgesForService(db: D1Database, serviceName: string, dependencies: string[]): Promise<void> {
  await db.prepare('DELETE FROM dependency_edges WHERE source_service = ?').bind(serviceName).run();

  for (const dep of dependencies) {
    await db.prepare(
      'INSERT OR IGNORE INTO dependency_edges (source_service, target_service, binding_name, required) VALUES (?, ?, ?, 1)'
    ).bind(serviceName, dep, null).run();
  }
}

// ─── Auth middleware ─────────────────────────────────────────────────────────

function authMiddleware(c: any, next: () => Promise<void>): Promise<Response | void> {
  const key = c.req.header('X-Echo-API-Key');
  if (key !== API_KEY) {
    return Promise.resolve(apiResponse(false, undefined, 'Unauthorized: invalid or missing X-Echo-API-Key', 401));
  }
  return next();
}

// ─── App ─────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-Echo-API-Key'],
}));

// ── Health (no auth) ─────────────────────────────────────────────────────────

app.get('/health', async (c) => {
  let dbOk = false;
  try {
    await c.env.DB.prepare('SELECT 1').first();
    dbOk = true;
  } catch { /* db down */ }

  return apiResponse(true, {
    service: 'echo-dependency-resolver',
    version: '1.0.0',
    status: dbOk ? 'healthy' : 'degraded',
    uptime_ms: Date.now() - START_TIME,
    db: dbOk ? 'connected' : 'error',
    timestamp: new Date().toISOString(),
  });
});

// ── Stats (no auth) ─────────────────────────────────────────────────────────

app.get('/stats', async (c) => {
  try {
    const [serviceCount, edgeCount, checkCount, lastCheck] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as cnt FROM services').first<{ cnt: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as cnt FROM dependency_edges').first<{ cnt: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as cnt FROM dependency_checks').first<{ cnt: number }>(),
      c.env.DB.prepare('SELECT * FROM dependency_checks ORDER BY checked_at DESC LIMIT 1').first<CheckRow>(),
    ]);

    return apiResponse(true, {
      services: serviceCount?.cnt ?? 0,
      edges: edgeCount?.cnt ?? 0,
      checks_run: checkCount?.cnt ?? 0,
      last_check: lastCheck ? {
        type: lastCheck.check_type,
        status: lastCheck.status,
        checked_at: lastCheck.checked_at,
      } : null,
      uptime_ms: Date.now() - START_TIME,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('stats_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── Auth-protected routes ────────────────────────────────────────────────────

app.use('/services/*', authMiddleware);
app.use('/services', authMiddleware);
app.use('/graph/*', authMiddleware);
app.use('/graph', authMiddleware);
app.use('/check/*', authMiddleware);
app.use('/import-from-wrangler', authMiddleware);

// ── GET /services ────────────────────────────────────────────────────────────

app.get('/services', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT * FROM services ORDER BY name').all<ServiceRow>();
    const services = (result.results ?? []).map((s) => ({
      ...s,
      dependencies: JSON.parse(s.dependencies),
    }));
    return apiResponse(true, services);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('list_services_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── POST /services ───────────────────────────────────────────────────────────

app.post('/services', async (c) => {
  try {
    const body = await c.req.json<ServiceInput>();
    if (!body.name) {
      return apiResponse(false, undefined, 'name is required', 400);
    }

    const deps = body.dependencies ?? [];
    const depsJson = JSON.stringify(deps);

    await c.env.DB.prepare(
      `INSERT INTO services (name, version, status, endpoint_url, binding_name, dependencies, health_status)
       VALUES (?, ?, ?, ?, ?, ?, 'unknown')
       ON CONFLICT(name) DO UPDATE SET
         version = excluded.version,
         status = excluded.status,
         endpoint_url = excluded.endpoint_url,
         binding_name = excluded.binding_name,
         dependencies = excluded.dependencies,
         updated_at = datetime('now')`
    ).bind(
      body.name,
      body.version ?? '1.0.0',
      body.status ?? 'active',
      body.endpoint_url ?? null,
      body.binding_name ?? null,
      depsJson,
    ).run();

    await syncEdgesForService(c.env.DB, body.name, deps);
    await c.env.CACHE.delete('graph');
    await c.env.CACHE.delete('graph_dot');

    log.info('service_registered', { name: body.name, version: body.version ?? '1.0.0', deps: deps.length });

    const created = await c.env.DB.prepare('SELECT * FROM services WHERE name = ?').bind(body.name).first<ServiceRow>();
    return apiResponse(true, { ...created, dependencies: JSON.parse(created?.dependencies ?? '[]') }, undefined, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('register_service_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── PUT /services/:id ────────────────────────────────────────────────────────

app.put('/services/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<Partial<ServiceInput>>();

    const existing = await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(id).first<ServiceRow>();
    if (!existing) {
      return apiResponse(false, undefined, 'Service not found', 404);
    }

    const name = body.name ?? existing.name;
    const version = body.version ?? existing.version;
    const status = body.status ?? existing.status;
    const endpointUrl = body.endpoint_url ?? existing.endpoint_url;
    const bindingName = body.binding_name ?? existing.binding_name;
    const deps = body.dependencies ?? JSON.parse(existing.dependencies);
    const depsJson = JSON.stringify(deps);

    await c.env.DB.prepare(
      `UPDATE services SET name = ?, version = ?, status = ?, endpoint_url = ?, binding_name = ?, dependencies = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(name, version, status, endpointUrl, bindingName, depsJson, id).run();

    await syncEdgesForService(c.env.DB, name, deps);
    await c.env.CACHE.delete('graph');
    await c.env.CACHE.delete('graph_dot');

    log.info('service_updated', { id, name });

    const updated = await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(id).first<ServiceRow>();
    return apiResponse(true, { ...updated, dependencies: JSON.parse(updated?.dependencies ?? '[]') });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('update_service_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── DELETE /services/:id ─────────────────────────────────────────────────────

app.delete('/services/:id', async (c) => {
  try {
    const id = c.req.param('id');

    const existing = await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(id).first<ServiceRow>();
    if (!existing) {
      return apiResponse(false, undefined, 'Service not found', 404);
    }

    await c.env.DB.prepare('DELETE FROM dependency_edges WHERE source_service = ? OR target_service = ?')
      .bind(existing.name, existing.name).run();
    await c.env.DB.prepare('DELETE FROM services WHERE id = ?').bind(id).run();
    await c.env.CACHE.delete('graph');
    await c.env.CACHE.delete('graph_dot');

    log.info('service_deleted', { id, name: existing.name });
    return apiResponse(true, { deleted: existing.name });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('delete_service_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── GET /services/:name/dependencies ─────────────────────────────────────────

app.get('/services/:name/dependencies', async (c) => {
  try {
    const name = c.req.param('name');
    const service = await c.env.DB.prepare('SELECT * FROM services WHERE name = ?').bind(name).first<ServiceRow>();
    if (!service) {
      return apiResponse(false, undefined, `Service '${name}' not found`, 404);
    }

    const edges = await c.env.DB.prepare('SELECT * FROM dependency_edges').all<EdgeRow>();
    const allEdges = edges.results ?? [];

    const directDeps = JSON.parse(service.dependencies) as string[];
    const transitiveDeps = getTransitiveDeps(allEdges, name);

    return apiResponse(true, {
      service: name,
      direct: directDeps,
      transitive: transitiveDeps,
      total: transitiveDeps.length,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('get_dependencies_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── GET /services/:name/dependents ───────────────────────────────────────────

app.get('/services/:name/dependents', async (c) => {
  try {
    const name = c.req.param('name');
    const service = await c.env.DB.prepare('SELECT * FROM services WHERE name = ?').bind(name).first<ServiceRow>();
    if (!service) {
      return apiResponse(false, undefined, `Service '${name}' not found`, 404);
    }

    const edges = await c.env.DB.prepare('SELECT * FROM dependency_edges').all<EdgeRow>();
    const allEdges = edges.results ?? [];

    const directDependents = allEdges
      .filter((e) => e.target_service === name)
      .map((e) => e.source_service);
    const transitiveDependents = getTransitiveDependents(allEdges, name);

    return apiResponse(true, {
      service: name,
      direct_dependents: directDependents,
      transitive_dependents: transitiveDependents,
      total: transitiveDependents.length,
      impact: transitiveDependents.length > 5 ? 'high' : transitiveDependents.length > 2 ? 'medium' : 'low',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('get_dependents_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── GET /graph ───────────────────────────────────────────────────────────────

app.get('/graph', async (c) => {
  try {
    const cached = await c.env.CACHE.get('graph', 'json');
    if (cached) {
      return apiResponse(true, cached);
    }

    const edges = await c.env.DB.prepare('SELECT * FROM dependency_edges').all<EdgeRow>();
    const allEdges = edges.results ?? [];
    const adjacencyList = buildAdjacencyList(allEdges);

    const services = await c.env.DB.prepare('SELECT name, version, status, health_status FROM services').all<ServiceRow>();
    const serviceList = services.results ?? [];

    const graphData = {
      adjacency_list: adjacencyList,
      services: serviceList,
      edge_count: allEdges.length,
      node_count: Object.keys(adjacencyList).length,
    };

    await c.env.CACHE.put('graph', JSON.stringify(graphData), { expirationTtl: CACHE_TTL });
    return apiResponse(true, graphData);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('get_graph_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── GET /graph/visualize ─────────────────────────────────────────────────────

app.get('/graph/visualize', async (c) => {
  try {
    const cached = await c.env.CACHE.get('graph_dot');
    if (cached) {
      return new Response(cached, { headers: { 'Content-Type': 'text/vnd.graphviz' } });
    }

    const [edgeResult, serviceResult] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM dependency_edges').all<EdgeRow>(),
      c.env.DB.prepare('SELECT * FROM services').all<ServiceRow>(),
    ]);

    const dot = buildDotGraph(edgeResult.results ?? [], serviceResult.results ?? []);
    await c.env.CACHE.put('graph_dot', dot, { expirationTtl: CACHE_TTL });

    return new Response(dot, { headers: { 'Content-Type': 'text/vnd.graphviz' } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('graph_visualize_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── POST /check/circular ─────────────────────────────────────────────────────

app.post('/check/circular', async (c) => {
  try {
    const edges = await c.env.DB.prepare('SELECT * FROM dependency_edges').all<EdgeRow>();
    const allEdges = edges.results ?? [];
    const cycles = detectCircularDeps(allEdges);

    const status = cycles.length === 0 ? 'pass' : 'fail';

    await c.env.DB.prepare(
      `INSERT INTO dependency_checks (check_type, status, details, circular_deps, missing_deps, version_conflicts)
       VALUES ('circular', ?, ?, ?, '[]', '[]')`
    ).bind(
      status,
      JSON.stringify({ edge_count: allEdges.length, cycles_found: cycles.length }),
      JSON.stringify(cycles),
    ).run();

    log.info('circular_check_complete', { status, cycles: cycles.length });

    return apiResponse(true, {
      check: 'circular_dependencies',
      status,
      cycles,
      cycles_found: cycles.length,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('circular_check_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── POST /check/missing ──────────────────────────────────────────────────────

app.post('/check/missing', async (c) => {
  try {
    const [servicesResult, edgesResult] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM services').all<ServiceRow>(),
      c.env.DB.prepare('SELECT * FROM dependency_edges').all<EdgeRow>(),
    ]);

    const serviceNames = new Set((servicesResult.results ?? []).map((s) => s.name));
    const allEdges = edgesResult.results ?? [];
    const missing: Array<{ service: string; missing_dependency: string; required: boolean }> = [];

    for (const edge of allEdges) {
      if (!serviceNames.has(edge.target_service)) {
        missing.push({
          service: edge.source_service,
          missing_dependency: edge.target_service,
          required: edge.required === 1,
        });
      }
    }

    const status = missing.length === 0 ? 'pass' : 'fail';

    await c.env.DB.prepare(
      `INSERT INTO dependency_checks (check_type, status, details, circular_deps, missing_deps, version_conflicts)
       VALUES ('missing', ?, ?, '[]', ?, '[]')`
    ).bind(
      status,
      JSON.stringify({ services_checked: serviceNames.size, edges_checked: allEdges.length }),
      JSON.stringify(missing),
    ).run();

    log.info('missing_check_complete', { status, missing: missing.length });

    return apiResponse(true, {
      check: 'missing_dependencies',
      status,
      missing,
      missing_count: missing.length,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('missing_check_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── POST /check/compatibility ────────────────────────────────────────────────

app.post('/check/compatibility', async (c) => {
  try {
    const [servicesResult, rulesResult] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM services').all<ServiceRow>(),
      c.env.DB.prepare('SELECT * FROM compatibility_rules').all<CompatRow>(),
    ]);

    const services = servicesResult.results ?? [];
    const rules = rulesResult.results ?? [];
    const serviceMap = new Map<string, ServiceRow>();
    for (const s of services) {
      serviceMap.set(s.name, s);
    }

    const conflicts: Array<{
      service: string;
      version: string;
      rule_id: number;
      min_version: string | null;
      max_version: string | null;
      issue: string;
    }> = [];

    for (const rule of rules) {
      const svc = serviceMap.get(rule.service_name);
      if (!svc) continue;

      if (!isVersionInRange(svc.version, rule.min_version, rule.max_version)) {
        conflicts.push({
          service: svc.name,
          version: svc.version,
          rule_id: rule.id,
          min_version: rule.min_version,
          max_version: rule.max_version,
          issue: `Version ${svc.version} outside allowed range [${rule.min_version ?? '*'}, ${rule.max_version ?? '*'}]`,
        });
      }
    }

    const status = conflicts.length === 0 ? 'pass' : 'fail';

    await c.env.DB.prepare(
      `INSERT INTO dependency_checks (check_type, status, details, circular_deps, missing_deps, version_conflicts)
       VALUES ('compatibility', ?, ?, '[]', '[]', ?)`
    ).bind(
      status,
      JSON.stringify({ services_checked: services.length, rules_checked: rules.length }),
      JSON.stringify(conflicts),
    ).run();

    log.info('compatibility_check_complete', { status, conflicts: conflicts.length });

    return apiResponse(true, {
      check: 'version_compatibility',
      status,
      conflicts,
      conflicts_found: conflicts.length,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('compatibility_check_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── POST /check/full ─────────────────────────────────────────────────────────

app.post('/check/full', async (c) => {
  try {
    const [servicesResult, edgesResult, rulesResult] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM services').all<ServiceRow>(),
      c.env.DB.prepare('SELECT * FROM dependency_edges').all<EdgeRow>(),
      c.env.DB.prepare('SELECT * FROM compatibility_rules').all<CompatRow>(),
    ]);

    const services = servicesResult.results ?? [];
    const allEdges = edgesResult.results ?? [];
    const rules = rulesResult.results ?? [];
    const serviceNames = new Set(services.map((s) => s.name));
    const serviceMap = new Map<string, ServiceRow>();
    for (const s of services) {
      serviceMap.set(s.name, s);
    }

    // Circular check
    const cycles = detectCircularDeps(allEdges);

    // Missing check
    const missing: Array<{ service: string; missing_dependency: string; required: boolean }> = [];
    for (const edge of allEdges) {
      if (!serviceNames.has(edge.target_service)) {
        missing.push({
          service: edge.source_service,
          missing_dependency: edge.target_service,
          required: edge.required === 1,
        });
      }
    }

    // Compatibility check
    const conflicts: Array<{ service: string; version: string; issue: string }> = [];
    for (const rule of rules) {
      const svc = serviceMap.get(rule.service_name);
      if (!svc) continue;
      if (!isVersionInRange(svc.version, rule.min_version, rule.max_version)) {
        conflicts.push({
          service: svc.name,
          version: svc.version,
          issue: `Version ${svc.version} outside range [${rule.min_version ?? '*'}, ${rule.max_version ?? '*'}]`,
        });
      }
    }

    const overallStatus = cycles.length === 0 && missing.length === 0 && conflicts.length === 0 ? 'pass' : 'fail';

    await c.env.DB.prepare(
      `INSERT INTO dependency_checks (check_type, status, details, circular_deps, missing_deps, version_conflicts)
       VALUES ('full', ?, ?, ?, ?, ?)`
    ).bind(
      overallStatus,
      JSON.stringify({
        services_checked: services.length,
        edges_checked: allEdges.length,
        rules_checked: rules.length,
      }),
      JSON.stringify(cycles),
      JSON.stringify(missing),
      JSON.stringify(conflicts),
    ).run();

    log.info('full_check_complete', {
      status: overallStatus,
      cycles: cycles.length,
      missing: missing.length,
      conflicts: conflicts.length,
    });

    return apiResponse(true, {
      check: 'full_dependency_audit',
      status: overallStatus,
      summary: {
        services: services.length,
        edges: allEdges.length,
        circular_dependencies: cycles.length,
        missing_dependencies: missing.length,
        version_conflicts: conflicts.length,
      },
      circular: { status: cycles.length === 0 ? 'pass' : 'fail', cycles },
      missing: { status: missing.length === 0 ? 'pass' : 'fail', items: missing },
      compatibility: { status: conflicts.length === 0 ? 'pass' : 'fail', conflicts },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('full_check_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── POST /import-from-wrangler ───────────────────────────────────────────────

app.post('/import-from-wrangler', async (c) => {
  try {
    const body = await c.req.json<{ content: string; service_name: string; version?: string; endpoint_url?: string }>();
    if (!body.content || !body.service_name) {
      return apiResponse(false, undefined, 'content and service_name are required', 400);
    }

    const bindings: WranglerBinding[] = [];
    const lines = body.content.split('\n');
    let currentBinding: Partial<WranglerBinding> = {};
    let inServicesBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed === '[[services]]') {
        if (currentBinding.binding && currentBinding.service) {
          bindings.push(currentBinding as WranglerBinding);
        }
        currentBinding = {};
        inServicesBlock = true;
        continue;
      }

      if (inServicesBlock) {
        const bindingMatch = trimmed.match(/^binding\s*=\s*"([^"]+)"/);
        const serviceMatch = trimmed.match(/^service\s*=\s*"([^"]+)"/);

        if (bindingMatch) {
          currentBinding.binding = bindingMatch[1];
        } else if (serviceMatch) {
          currentBinding.service = serviceMatch[1];
        } else if (trimmed.startsWith('[') || trimmed === '') {
          if (currentBinding.binding && currentBinding.service) {
            bindings.push(currentBinding as WranglerBinding);
          }
          currentBinding = {};
          if (trimmed.startsWith('[') && trimmed !== '[[services]]') {
            inServicesBlock = false;
          }
        }
      }
    }

    // Capture the last binding
    if (currentBinding.binding && currentBinding.service) {
      bindings.push(currentBinding as WranglerBinding);
    }

    const dependencies = bindings.map((b) => b.service);

    // Register the service
    const depsJson = JSON.stringify(dependencies);
    await c.env.DB.prepare(
      `INSERT INTO services (name, version, status, endpoint_url, binding_name, dependencies, health_status)
       VALUES (?, ?, 'active', ?, ?, ?, 'unknown')
       ON CONFLICT(name) DO UPDATE SET
         version = excluded.version,
         endpoint_url = excluded.endpoint_url,
         dependencies = excluded.dependencies,
         updated_at = datetime('now')`
    ).bind(
      body.service_name,
      body.version ?? '1.0.0',
      body.endpoint_url ?? null,
      null,
      depsJson,
    ).run();

    // Sync edges with binding names
    await c.env.DB.prepare('DELETE FROM dependency_edges WHERE source_service = ?').bind(body.service_name).run();
    for (const b of bindings) {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO dependency_edges (source_service, target_service, binding_name, required) VALUES (?, ?, ?, 1)'
      ).bind(body.service_name, b.service, b.binding).run();
    }

    await c.env.CACHE.delete('graph');
    await c.env.CACHE.delete('graph_dot');

    log.info('wrangler_import_complete', { service: body.service_name, bindings: bindings.length });

    return apiResponse(true, {
      service: body.service_name,
      bindings_found: bindings.length,
      bindings,
      dependencies,
    }, undefined, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('wrangler_import_failed', { error: msg });
    return apiResponse(false, undefined, msg, 500);
  }
});

// ── 404 ──────────────────────────────────────────────────────────────────────

app.notFound(() => apiResponse(false, undefined, 'Not found', 404));

// ── Global error handler ─────────────────────────────────────────────────────

app.onError((err, _c) => {
  log.error('unhandled_error', { error: err.message, stack: err.stack });
  return apiResponse(false, undefined, 'Internal server error', 500);
});

// ─── Cron Handler ────────────────────────────────────────────────────────────

async function handleCron(env: Env): Promise<void> {
  log.info('cron_started', { trigger: '6h_dependency_check' });

  try {
    const [servicesResult, edgesResult, rulesResult] = await Promise.all([
      env.DB.prepare('SELECT * FROM services').all<ServiceRow>(),
      env.DB.prepare('SELECT * FROM dependency_edges').all<EdgeRow>(),
      env.DB.prepare('SELECT * FROM compatibility_rules').all<CompatRow>(),
    ]);

    const services = servicesResult.results ?? [];
    const allEdges = edgesResult.results ?? [];
    const rules = rulesResult.results ?? [];
    const serviceNames = new Set(services.map((s) => s.name));
    const serviceMap = new Map<string, ServiceRow>();
    for (const s of services) {
      serviceMap.set(s.name, s);
    }

    // Run all checks
    const cycles = detectCircularDeps(allEdges);
    const missing: Array<{ service: string; missing_dependency: string }> = [];
    for (const edge of allEdges) {
      if (!serviceNames.has(edge.target_service)) {
        missing.push({ service: edge.source_service, missing_dependency: edge.target_service });
      }
    }

    const conflicts: Array<{ service: string; issue: string }> = [];
    for (const rule of rules) {
      const svc = serviceMap.get(rule.service_name);
      if (!svc) continue;
      if (!isVersionInRange(svc.version, rule.min_version, rule.max_version)) {
        conflicts.push({
          service: svc.name,
          issue: `Version ${svc.version} outside range [${rule.min_version ?? '*'}, ${rule.max_version ?? '*'}]`,
        });
      }
    }

    const overallStatus = cycles.length === 0 && missing.length === 0 && conflicts.length === 0 ? 'pass' : 'fail';

    // Store result
    await env.DB.prepare(
      `INSERT INTO dependency_checks (check_type, status, details, circular_deps, missing_deps, version_conflicts)
       VALUES ('cron_full', ?, ?, ?, ?, ?)`
    ).bind(
      overallStatus,
      JSON.stringify({ services: services.length, edges: allEdges.length, rules: rules.length }),
      JSON.stringify(cycles),
      JSON.stringify(missing),
      JSON.stringify(conflicts),
    ).run();

    // Cache the graph
    const adjacencyList = buildAdjacencyList(allEdges);
    await env.CACHE.put('graph', JSON.stringify({
      adjacency_list: adjacencyList,
      services: services.map((s) => ({ name: s.name, version: s.version, status: s.status, health_status: s.health_status })),
      edge_count: allEdges.length,
      node_count: Object.keys(adjacencyList).length,
    }), { expirationTtl: CACHE_TTL });

    // Alert if issues found
    if (overallStatus === 'fail') {
      const alertPayload = {
        source: 'echo-dependency-resolver',
        severity: cycles.length > 0 ? 'critical' : 'warning',
        title: 'Dependency Check Failed',
        details: {
          circular_deps: cycles.length,
          missing_deps: missing.length,
          version_conflicts: conflicts.length,
          cycles,
          missing,
          conflicts,
        },
        timestamp: new Date().toISOString(),
      };

      try {
        await env.ALERT_ROUTER.fetch('https://alert-router/alert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(alertPayload),
        });
      } catch (alertErr) {
        log.warn('alert_send_failed', { error: alertErr instanceof Error ? alertErr.message : String(alertErr) });
      }

      // Also post to Shared Brain
      try {
        await env.SHARED_BRAIN.fetch('https://shared-brain/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Echo-API-Key': API_KEY,
          },
          body: JSON.stringify({
            role: 'system',
            content: `[DEPENDENCY-RESOLVER] Check FAILED: ${cycles.length} circular deps, ${missing.length} missing, ${conflicts.length} version conflicts`,
            metadata: { source: 'echo-dependency-resolver', check_status: overallStatus },
          }),
        });
      } catch (brainErr) {
        log.warn('brain_notify_failed', { error: brainErr instanceof Error ? brainErr.message : String(brainErr) });
      }
    }

    log.info('cron_completed', {
      status: overallStatus,
      services: services.length,
      cycles: cycles.length,
      missing: missing.length,
      conflicts: conflicts.length,
    });
  } catch (err: unknown) {
    log.error('cron_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,
  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(env));
  },
};

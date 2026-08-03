import { sql } from "../memory/db.ts";

export interface Project {
  id: number;
  name: string;
  path: string;
  tmux_session_name: string;
  created_at: Date;
}

export interface ProjectWithSession extends Project {
  session_id: number | null;
  session_status: string | null;
}

/** A project's provider/model choice. All-null means the default Anthropic endpoint. */
export interface ProviderSelection {
  providerId: number | null;
  providerName: string | null;
  model: string | null;
}

export class ProjectService {
  async list(): Promise<ProjectWithSession[]> {
    return sql`
      SELECT p.id, p.name, p.path, p.tmux_session_name, p.created_at,
             s.id as session_id, s.status as session_status
      FROM projects p
      LEFT JOIN LATERAL (
        SELECT id, status FROM sessions
        WHERE project_id = p.id AND source = 'remote'
        ORDER BY (status = 'active') DESC, last_active DESC NULLS LAST
        LIMIT 1
      ) s ON true
      ORDER BY p.name
    ` as unknown as ProjectWithSession[];
  }

  async get(id: number): Promise<Project | null> {
    const rows = await sql`SELECT id, name, path, tmux_session_name, created_at FROM projects WHERE id = ${id}` as unknown as Project[];
    return rows[0] ?? null;
  }

  async getByPath(path: string): Promise<Project | null> {
    const rows = await sql`SELECT id, name, path, tmux_session_name, created_at FROM projects WHERE path = ${path}` as unknown as Project[];
    return rows[0] ?? null;
  }

  /** Current provider/model selection, with the provider's display name resolved. */
  async getProviderSelection(id: number): Promise<ProviderSelection | null> {
    const [row] = await sql`
      SELECT pr.provider_id, pr.model, pv.name AS provider_name
      FROM projects pr
      LEFT JOIN providers pv ON pv.id = pr.provider_id
      WHERE pr.id = ${id}
    `;
    if (!row) return null;
    return {
      providerId: row.provider_id ?? null,
      providerName: row.provider_name ?? null,
      model: row.model ?? null,
    };
  }

  /** null clears the selection, returning the project to the default Anthropic endpoint. */
  async setProvider(id: number, providerId: number | null): Promise<void> {
    await sql`UPDATE projects SET provider_id = ${providerId} WHERE id = ${id}`;
  }

  /** null clears the model, letting the provider (or Claude) pick its default. */
  async setModel(id: number, model: string | null): Promise<void> {
    await sql`UPDATE projects SET model = ${model} WHERE id = ${id}`;
  }

  /**
   * Restart a project so a provider/model change takes effect.
   *
   * Provider config is resolved at launch inside run-cli.sh, so a running
   * session keeps its old endpoint until it is restarted — the DB write alone
   * changes nothing visible. Delegates to enqueueRestart, which dedupes against
   * an already-pending proj_start.
   */
  async restart(id: number, reason: string, requestedBy = "user:provider-change"): Promise<"queued" | "skipped_already_pending"> {
    return enqueueRestart(sql, id, reason, requestedBy);
  }

  async create(name: string, path: string): Promise<Project | null> {
    // tmux's rule for a window name. `utils/supervisor-status.ts` carries the
    // same character class for Docker compose project names — deliberately not
    // shared: the sets coincide today because the two systems happen to agree,
    // and each is owned by its own. Note the different replacement, which is
    // the visible half of the difference.
    const tmuxName = name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    const rows = await sql`
      INSERT INTO projects (name, path, tmux_session_name)
      VALUES (${name}, ${path}, ${tmuxName})
      ON CONFLICT (path) DO NOTHING
      RETURNING id, name, path, tmux_session_name, created_at
    `;
    if (rows.length === 0) return null; // already exists

    const project = rows[0] as Project;

    // Register remote session
    await sql`
      INSERT INTO sessions (project_id, name, project_path, source, status)
      VALUES (${project.id}, ${project.name}, ${project.path}, 'remote', 'inactive')
      ON CONFLICT DO NOTHING
    `.catch((err: unknown) => {
      console.error("[projects] failed to create remote session:", err);
    });

    return project;
  }

  async delete(id: number): Promise<{ ok: boolean; error?: string }> {
    const [project] = await sql`SELECT id FROM projects WHERE id = ${id}`;
    if (!project) return { ok: false, error: "Project not found" };

    const activeSessions = await sql`
      SELECT id FROM sessions WHERE project_id = ${id} AND status = 'active'
    `;
    if (activeSessions.length > 0) {
      return { ok: false, error: "Cannot delete project with active sessions" };
    }

    await sql`DELETE FROM projects WHERE id = ${id}`;
    return { ok: true };
  }

  async start(id: number): Promise<{ ok: boolean; error?: string }> {
    return this.action(id, "proj_start");
  }

  async stop(id: number): Promise<{ ok: boolean; error?: string }> {
    return this.action(id, "proj_stop");
  }

  private async action(id: number, command: string): Promise<{ ok: boolean; error?: string }> {
    const [project] = await sql`SELECT id, name, path, tmux_session_name FROM projects WHERE id = ${id}`;
    if (!project) return { ok: false, error: "Project not found" };

    // Idempotency: skip if a command for this project is already pending/processing
    const [existing] = await sql`
      SELECT id FROM admin_commands
      WHERE command = ${command}
        AND (payload->>'project_id')::int = ${id}
        AND status IN ('pending', 'processing')
      LIMIT 1
    `;
    if (existing) return { ok: true };

    await sql`INSERT INTO admin_commands (command, payload) VALUES (${command}, ${sql.json({
      project_id: id,
      path: project.path,
      name: project.name,
      tmux_session_name: project.tmux_session_name,
    })})`;
    return { ok: true };
  }
}

export const projectService = new ProjectService();

/**
 * Idempotent restart enqueue — the single authoritative path for all proj_start commands.
 * Callers pass their own sql connection; this function never touches the module-level singleton.
 */
export async function enqueueRestart(
  sql: import("postgres").Sql,
  projectId: number,
  reason: string,
  requestedBy: string,
): Promise<"queued" | "skipped_already_pending"> {
  const [existing] = await sql`
    SELECT id FROM admin_commands
    WHERE command = 'proj_start'
      AND (payload->>'project_id')::int = ${projectId}
      AND status IN ('pending', 'processing')
    LIMIT 1
  `;
  if (existing) return "skipped_already_pending";

  const [project] = await sql`
    SELECT path, name, tmux_session_name FROM projects WHERE id = ${projectId}
  `;
  if (!project) throw new Error(`enqueueRestart: project ${projectId} not found`);

  await sql`
    INSERT INTO admin_commands (command, payload)
    VALUES ('proj_start', ${sql.json({
      project_id: projectId,
      path: project.path,
      name: project.name,
      tmux_session_name: project.tmux_session_name,
      reason,
      requestedBy,
    })})
  `;
  return "queued";
}

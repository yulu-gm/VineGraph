export type ProjectKind = "git" | "directory";
export type ThemeMode = "system" | "dark" | "light";
export type WorkspaceTargetKind = "main" | "worktree" | "directory";

export interface AppConfig {
  version: 1;
  controllerApiKey?: string;
  codexCliPath?: string;
  claudeCliPath?: string;
  defaultCodexModel?: string;
  defaultClaudeModel?: string;
  defaultControllerModel?: string;
  defaultReasoningEffort?: string;
  themeMode: ThemeMode;
  graphAssetGlobs: string[];
  recentProjects: ProjectRecord[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  kind: ProjectKind;
  graphAssetGlobs: string[];
  defaultVerificationCommand?: string;
  createdAt: number;
  lastOpenedAt: number;
}

export interface ProjectCapabilities {
  git: boolean;
  worktrees: boolean;
  diff: boolean;
  changedFiles: boolean;
}

export interface ProjectDetails extends ProjectRecord {
  capabilities: ProjectCapabilities;
  branch?: string | null;
  dirty?: boolean;
}

export interface GraphAsset {
  projectId: string;
  absolutePath: string;
  relativePath: string;
  name: string;
  graphId?: string;
  version?: string;
  updatedAt?: number;
}

export interface WorkspaceTarget {
  id: string;
  kind: WorkspaceTargetKind;
  label: string;
  path: string;
  branch?: string | null;
  detached?: boolean;
  current?: boolean;
  dirty?: boolean;
}

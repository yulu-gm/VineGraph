import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import {
  createWorkspaceTarget,
  listWorkspaceTargets,
} from "../src/workspace-targets.js";
import type { ProjectDetails } from "../src/product-types.js";

function tempDir(prefix: string): string {
  const dir = resolve(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function directoryProject(rootPath: string): ProjectDetails {
  return {
    id: "directory-project",
    name: "Directory Project",
    rootPath,
    kind: "directory",
    graphAssetGlobs: [],
    createdAt: 1,
    lastOpenedAt: 1,
    capabilities: {
      git: false,
      worktrees: false,
      diff: false,
      changedFiles: false,
    },
  };
}

function gitProject(rootPath: string): ProjectDetails {
  return {
    id: "git-project",
    name: "Git Project",
    rootPath,
    kind: "git",
    graphAssetGlobs: [],
    createdAt: 1,
    lastOpenedAt: 1,
    capabilities: {
      git: true,
      worktrees: true,
      diff: true,
      changedFiles: true,
    },
  };
}

function initGitRepo(repo: string): void {
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "agentgraph@example.test"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "AgentGraph Test"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repo });
  writeFileSync(resolve(repo, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });
}

test("plain directory project exposes exactly one directory workspace target", async () => {
  const projectRoot = tempDir("vinegraph-directory-target");

  try {
    const targets = await listWorkspaceTargets(directoryProject(projectRoot));

    assert.deepEqual(targets, [
      {
        id: "directory",
        kind: "directory",
        label: "Project directory",
        path: projectRoot,
        current: true,
      },
    ]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("git project lists main workspace and created worktree target", async () => {
  const projectRoot = tempDir("vinegraph-git-target");

  try {
    initGitRepo(projectRoot);

    const created = await createWorkspaceTarget(
      gitProject(projectRoot),
      "Review Lane"
    );
    const expectedWorktreePath = resolve(
      projectRoot,
      ".agentgraph",
      "worktrees",
      "review-lane"
    );

    assert.equal(created.kind, "worktree");
    assert.equal(created.path, expectedWorktreePath);
    assert.equal(created.detached, true);
    assert.equal(existsSync(expectedWorktreePath), true);

    const targets = await listWorkspaceTargets(gitProject(projectRoot));
    const main = targets.find((target) => target.kind === "main");
    const worktree = targets.find(
      (target) => target.kind === "worktree" && target.path === expectedWorktreePath
    );

    assert.equal(targets.length, 2);
    assert.equal(main?.id, "main");
    assert.equal(main?.label, "Main working tree");
    assert.equal(main?.path, projectRoot);
    assert.equal(main?.current, true);
    assert.equal(main?.dirty, true);
    assert.ok(main?.branch);
    assert.match(worktree?.id ?? "", /^worktree:/);
    assert.match(worktree?.id ?? "", /review-lane/);
    assert.equal(worktree?.label, basename(expectedWorktreePath));
    assert.equal(worktree?.detached, true);
    assert.equal(worktree?.current, false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("worktree target ids stay distinct for external worktrees with the same basename", async () => {
  const projectRoot = tempDir("vinegraph-external-target");
  const externalParentA = tempDir("vinegraph-external-parent-a");
  const externalParentB = tempDir("vinegraph-external-parent-b");

  try {
    initGitRepo(projectRoot);
    const externalA = resolve(externalParentA, "review");
    const externalB = resolve(externalParentB, "review");
    execFileSync("git", ["worktree", "add", "--detach", externalA, "HEAD"], {
      cwd: projectRoot,
    });
    execFileSync("git", ["worktree", "add", "--detach", externalB, "HEAD"], {
      cwd: projectRoot,
    });

    const targets = await listWorkspaceTargets(gitProject(projectRoot));
    const worktrees = targets.filter((target) => target.kind === "worktree");
    const ids = new Set(worktrees.map((target) => target.id));

    assert.equal(worktrees.length, 2);
    assert.equal(ids.size, 2);
    assert.equal(worktrees.every((target) => target.label === "review"), true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(externalParentA, { recursive: true, force: true });
    rmSync(externalParentB, { recursive: true, force: true });
  }
});

test("case-different worktree paths are distinct from the project root on case-sensitive platforms", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows path comparison is case-insensitive");
    return;
  }

  const parent = tempDir("vinegraph-case-target");
  const projectRoot = resolve(parent, "Repo");
  const externalPath = resolve(parent, "repo");
  const fakeBin = resolve(parent, "fake-bin");
  const fakeGit = resolve(fakeBin, "git");
  const originalPath = process.env.PATH;

  try {
    mkdirSync(projectRoot, { recursive: true });
    if (existsSync(externalPath)) {
      t.skip("Host filesystem resolves case-different paths to the same entry");
      return;
    }

    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      fakeGit,
      [
        "#!/bin/sh",
        "if [ \"$1 $2 $3\" = \"worktree list --porcelain\" ]; then",
        `  printf 'worktree %s\\nHEAD main-head\\nbranch refs/heads/main\\n\\nworktree %s\\nHEAD external-head\\ndetached\\n\\n' '${projectRoot}' '${externalPath}'`,
        "  exit 0",
        "fi",
        "if [ \"$1 $2\" = \"branch --show-current\" ]; then",
        "  printf 'main\\n'",
        "  exit 0",
        "fi",
        "if [ \"$1 $2\" = \"status --porcelain\" ]; then",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf-8"
    );
    chmodSync(fakeGit, 0o755);
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

    const targets = await listWorkspaceTargets(gitProject(projectRoot));
    const worktree = targets.find((target) => target.kind === "worktree");

    assert.equal(targets.filter((target) => target.kind === "main").length, 1);
    assert.equal(targets.filter((target) => target.kind === "worktree").length, 1);
    assert.equal(worktree?.path, externalPath);
    assert.equal(worktree?.current, false);
  } finally {
    process.env.PATH = originalPath;
    rmSync(parent, { recursive: true, force: true });
  }
});

test("non-git projects cannot create worktree targets", async () => {
  const projectRoot = tempDir("vinegraph-non-git-create-target");

  try {
    await assert.rejects(
      () => createWorkspaceTarget(directoryProject(projectRoot), "Review Lane"),
      /requires a git project/
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("worktree names are sanitized and invalid names fail clearly", async () => {
  const projectRoot = tempDir("vinegraph-worktree-name-target");

  try {
    initGitRepo(projectRoot);

    const target = await createWorkspaceTarget(
      gitProject(projectRoot),
      "  Feature: QA Lane!  "
    );

    assert.equal(
      target.path,
      resolve(projectRoot, ".agentgraph", "worktrees", "feature-qa-lane")
    );

    await assert.rejects(
      () => createWorkspaceTarget(gitProject(projectRoot), "../bad"),
      /Invalid workspace target name/
    );
    await assert.rejects(
      () => createWorkspaceTarget(gitProject(projectRoot), "!!!"),
      /Invalid workspace target name/
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

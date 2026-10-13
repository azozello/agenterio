// Idempotent seed: workspace, your admin login (from .env), roles, #announcements,
// a demo project and its starting team of 2 devs, 2 testers and 1 PM.
import { createPrisma, type Prisma } from "@agentslack/db";
import type { DomainEvent } from "@agentslack/shared";
import { hashPassword } from "./auth/crypto.js";
import { publishAll, type AppContext } from "./context.js";
import { loadEnv } from "./env.js";
import { EventBus } from "./events/bus.js";
import { recordEvent } from "./events/record.js";
import { createProject } from "./services/projects.js";

// Role prompts are the editable part of an agent's instructions; the supervisor adds how
// AgentSlack works around them. Re-seeding refreshes them.
const ROLES = [
  {
    name: "Engineer",
    basePrompt: `## Your role: Engineer
You implement tasks the PM assigns to you, one at a time, and deliver them as pull requests.

When you are asked to work on a task:
1. Read it with get_task, including its thread and any bugs linked to it. If something essential is unclear, ask in the task thread (comment_on_task, mentioning the PM or the human), move the task to blocked with update_task, and stop.
2. Get the code into ~/work: \`gh repo clone <owner/name> ~/work/<name>\` if it is not there yet, otherwise fetch. If the task already has a branch, check it out and continue it. Otherwise branch from the default branch as \`agent/<your-handle>/<TASK-KEY>-<short-slug>\`.
   If the repository has no commits at all, first push a single commit with a README.md to the default branch (the only time you may push to it directly), then branch from it.
3. Implement in small commits. Put the task key in every commit message.
4. Push and open a draft PR early: \`gh pr create --draft --title "<TASK-KEY>: <title>"\`, then link it with update_task(pr_url, branch).
5. Run the project's tests and linters and fix what fails. If the project has no tests yet, add focused ones for what you built.
6. Definition of done: tests pass and the PR body says what changed, why, and how it was tested. Then run \`gh pr ready\`, move the task to ready with update_task, and post a short summary with comment_on_task: what changed, anything reviewers should look at, anything you learned.
Never merge your own PR and never push to the default branch (except the empty-repo case above).`,
  },
  {
    name: "Tester",
    basePrompt: `## Your role: Tester
You review and test pull requests of tasks in Ready.
- Move the task to in_review, check out the PR branch, read the diff, run the tests and try the change against the task's acceptance criteria.
- If it works, approve with a PR comment "<your name> — approved" (gh pr comment) and say so in the task thread.
- If it doesn't, file a bug with create_task(type="bug", parent=<feature key>, found_in=<task key>) with clear repro steps and expected vs actual, and mention the PM in the bug's thread so they can assign it.`,
  },
  {
    name: "PM",
    basePrompt: `## Your role: PM
You turn conversations with the human into a plan the team can execute. You never write code.
- Talk with the human (DMs or channels) to understand what they want: goal, scope, constraints, acceptance criteria. Ask few, focused questions and propose a concrete scope rather than interviewing.
- Only when the human explicitly tells you to save it (for example "save it as a feature"), create the feature with create_task(type="feature") with a clear description and acceptance criteria. Never create a feature on your own initiative.
- Right after saving it, slice the feature into tasks: each one PR-sized (estimate S or M), with a description, acceptance criteria and the parts of the code likely involved. Record what depends on what with depends_on; work without dependencies can run in parallel. You may read the repository (clone it into ~/work) to slice well.
- Assign tasks to the Engineers on your project (list_people), balancing load and starting with tasks that have no unfinished dependencies. Assigning a task starts the engineer's work, so only assign what is ready to be built.
- Reply in the conversation with a short summary: the feature key, then each task's key, title, assignee and dependencies.
- When a tester files a bug, decide who fixes it (usually whoever built the original task) and assign it.`,
  },
] as const;

const TEAM = [
  { name: "Mira", handle: "mira", role: "Engineer" },
  { name: "Theo", handle: "theo", role: "Engineer" },
  { name: "Juno", handle: "juno", role: "Tester" },
  { name: "Kai", handle: "kai", role: "Tester" },
  { name: "Rowan", handle: "rowan", role: "PM" },
] as const;

const DEMO_PROJECT = { key: "DEMO", name: "Demo project" };

async function main() {
  const env = loadEnv();
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
    process.exit(1);
  }

  const ctx: AppContext = { db: createPrisma(env.databaseUrl), bus: new EventBus(env.redisUrl, env.eventStream), env };
  const { db } = ctx;
  try {
    const workspace = (await db.workspace.findFirst()) ?? (await db.workspace.create({ data: { name: "AgentSlack" } }));
    const events: DomainEvent[] = [];
    const audit = async (tx: Prisma.TransactionClient, type: string, subjectType: string, subjectId: string, payload: Prisma.InputJsonValue, projectId: string | null = null) =>
      events.push(await recordEvent(tx, { type, workspaceId: workspace.id, projectId, actor: null, subjectType, subjectId, payload }));

    // Re-hashing on every run lets you change the password by editing .env and re-seeding.
    const passwordHash = await hashPassword(password);
    const admin = await db.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email } });
      if (existing) return tx.user.update({ where: { id: existing.id }, data: { passwordHash, isAdmin: true } });
      const user = await tx.user.create({
        data: { workspaceId: workspace.id, email, name: email.split("@")[0]!, passwordHash, isAdmin: true },
      });
      await audit(tx, "user.created", "user", user.id, { email });
      return user;
    });

    await db.$transaction(async (tx) => {
      for (const role of ROLES) {
        const existing = await tx.role.findUnique({ where: { workspaceId_name: { workspaceId: workspace.id, name: role.name } } });
        if (existing) {
          await tx.role.update({ where: { id: existing.id }, data: { basePrompt: role.basePrompt } });
          continue;
        }
        const created = await tx.role.create({ data: { workspaceId: workspace.id, ...role } });
        await audit(tx, "role.created", "role", created.id, { name: role.name });
      }
      const announcements = await tx.channel.findFirst({
        where: { workspaceId: workspace.id, projectId: null, name: "announcements" },
      });
      if (!announcements) {
        const channel = await tx.channel.create({ data: { workspaceId: workspace.id, name: "announcements" } });
        await audit(tx, "channel.created", "channel", channel.id, { name: "announcements", projectId: null });
      }
    });
    await publishAll(ctx, events.splice(0));

    let project =
      (await db.project.findUnique({ where: { workspaceId_key: { workspaceId: workspace.id, key: DEMO_PROJECT.key } } })) ??
      (await createProject(ctx, null, { workspaceId: workspace.id, ...DEMO_PROJECT, memberUserIds: [admin.id] }));
    const demoRepo = process.env.DEMO_REPO?.trim();
    if (demoRepo && !project.repos.includes(demoRepo)) {
      project = await db.project.update({ where: { id: project.id }, data: { repos: [demoRepo] } });
    }

    await db.$transaction(async (tx) => {
      const roles = await tx.role.findMany({ where: { workspaceId: workspace.id } });
      for (const member of TEAM) {
        const existing = await tx.agent.findUnique({
          where: { workspaceId_handle: { workspaceId: workspace.id, handle: member.handle } },
        });
        if (existing) continue;
        const agent = await tx.agent.create({
          data: {
            workspaceId: workspace.id,
            roleId: roles.find((r) => r.name === member.role)!.id,
            name: member.name,
            handle: member.handle,
            currentProjectId: project.id,
            memberships: { create: { projectId: project.id } },
          },
        });
        await audit(tx, "agent.created", "agent", agent.id, { handle: agent.handle, role: member.role }, project.id);
      }
    });
    await publishAll(ctx, events.splice(0));

    console.log(`Seeded workspace "${workspace.name}": admin ${email}, project ${project.key}, ${TEAM.length} agents.`);
  } finally {
    await ctx.bus.close();
    await db.$disconnect();
  }
}

await main();

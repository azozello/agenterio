import type { SetStatusRequest } from "@agentslack/shared";
import type { Actor } from "../auth/actor.js";
import { publishAll, type AppContext } from "../context.js";
import { recordEvent } from "../events/record.js";
import { toAgentPerson } from "./dto.js";
import { forbidden } from "./errors.js";

/** The agent's presence and one-line status, e.g. working · "Implementing DEMO-3". */
export async function setAgentStatus(ctx: AppContext, actor: Actor, input: SetStatusRequest) {
  if (actor.kind !== "agent") throw forbidden("only agents have a status");
  const { person, event } = await ctx.db.$transaction(async (tx) => {
    const agent = await tx.agent.update({
      where: { id: actor.agentId },
      data: { status: input.status, statusText: input.statusText ?? "" },
      include: { role: true },
    });
    const person = toAgentPerson(agent);
    const event = await recordEvent(tx, {
      type: "agent.updated",
      workspaceId: agent.workspaceId,
      projectId: agent.currentProjectId,
      actor,
      subjectType: "agent",
      subjectId: agent.id,
      payload: { person },
    });
    return { person, event };
  });
  await publishAll(ctx, [event]);
  return person;
}

/**
 * Schema-level tests of the plugin tables (ticket 02): the migration applies under the host's
 * rules, the constraints carry the spec's invariants, and every data-access read is scoped to
 * one company. Behaviour tests stay at the route seam (later tickets).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import manifest from "../../src/manifest.js";
import {
  countActiveParticipants,
  getActiveRound,
  getMessage,
  getMessageByIdempotencyKey,
  getRoom,
  getRound,
  getTurn,
  insertMessage,
  insertParticipant,
  insertRoom,
  insertRound,
  insertTurn,
  insertWorkLink,
  listActiveParticipants,
  listMessages,
  listRooms,
  listRounds,
  listTurns,
  listWorkLinks,
  listWorkLinksForIssue,
  findTurnByRunId,
  nextRoundSeq,
  removeParticipant,
  setRoundStatus,
  type Room,
  type Round,
} from "../../src/db/index.js";
import { CORE_TABLES_SQL } from "../support/core-tables.js";
import {
  BOARDROOM_NAMESPACE,
  applyMigrations,
  createBoardroomHarness,
  type BoardroomHarness,
  type SeededCompany,
} from "../support/harness.js";
import { splitSqlStatements } from "../support/host-sql-rules.js";

const NS = BOARDROOM_NAMESPACE;
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const TABLES = ["rooms", "room_participants", "room_messages", "rounds", "turns", "work_links"] as const;

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(): Promise<BoardroomHarness> {
  harness = await createBoardroomHarness();
  return harness;
}

/** One Room with a Participant, a user Message, a running Round with one Turn, and a work link. */
async function seedRoomGraph(h: BoardroomHarness, company: SeededCompany) {
  const db = h.ctx.db;
  const owner = company.members.owner.userId;
  const agent = company.agents[0]!;
  const room = await insertRoom(db, company.id, { title: "Pricing", topic: "Raise prices?", ownerUserId: owner });
  const participant = await insertParticipant(db, company.id, { roomId: room.id, agentId: agent.id, addedByUserId: owner });
  const message = await insertMessage(db, company.id, {
    roomId: room.id,
    authorKind: "user",
    authorId: owner,
    body: "@CEO thoughts?",
    idempotencyKey: "send-1",
  });
  const round = await insertRound(db, company.id, {
    roomId: room.id,
    seq: 1,
    startedByUserId: owner,
    triggerMessageId: message!.id,
    askAll: false,
    addressedAgentIds: [agent.id],
  });
  const turn = await insertTurn(db, company.id, { roundId: round!.id, agentId: agent.id, ord: 1 });
  const issueId = crypto.randomUUID();
  const link = await insertWorkLink(db, company.id, { roomId: room.id, issueId, relation: "linked", byUserId: owner });
  return { room, participant: participant!, message: message!, round: round!, turn: turn!, link: link!, issueId, agent };
}

describe("migration", () => {
  it("creates the six tables in the plugin namespace through the harness", async () => {
    const h = await start();
    const rows = await h.sql<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [NS],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort());
  });

  it("gives every table a uuid id and a NOT NULL company_id that references public.companies", async () => {
    const h = await start();
    for (const table of TABLES) {
      const cols = await h.sql<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name IN ('id', 'company_id')`,
        [NS, table],
      );
      expect(cols, table).toEqual(
        expect.arrayContaining([
          { column_name: "id", data_type: "uuid", is_nullable: "NO" },
          { column_name: "company_id", data_type: "uuid", is_nullable: "NO" },
        ]),
      );
      const fks = await h.sql<{ ref: string }>(
        `SELECT confrelid::regclass::text AS ref FROM pg_constraint
         WHERE contype = 'f' AND conrelid = $1::regclass AND confrelid = 'public.companies'::regclass`,
        [`${NS}.${table}`],
      );
      expect(fks, table).toHaveLength(1);
    }
  });

  it("applies cleanly again on a brand-new database, with the host's statement rules", async () => {
    for (let i = 0; i < 2; i += 1) {
      const pg = await PGlite.create();
      try {
        await pg.exec(CORE_TABLES_SQL);
        await applyMigrations(pg, manifest, NS, MIGRATIONS_DIR);
        const rows = await pg.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1",
          [NS],
        );
        expect(rows.rows[0]!.n).toBe(TABLES.length);
      } finally {
        await pg.close();
      }
    }
  });

  it("contains no statement the host would reject: no extensions, triggers, functions or public changes", async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    expect(files).toContain("001_boardroom.sql");
    for (const file of files) {
      const statements = splitSqlStatements(await readFile(path.join(MIGRATIONS_DIR, file), "utf8"));
      for (const statement of statements) {
        const sql = statement.replace(/--.*$/gm, "").trim().toLowerCase();
        expect(sql, statement).not.toMatch(/\bcreate\s+extension\b|\btrigger\b|\bfunction\b|\bgrant\b|\bdo\s+\$\$/);
        // `public` appears only as the target of a company foreign key.
        for (const match of sql.matchAll(/(\w+)\s+public\.(\w+)/g)) {
          expect(`${match[1]} public.${match[2]}`, statement).toBe("references public.companies");
        }
        expect(sql).toMatch(/^(create|alter)\b/);
        expect(sql).toContain(`${NS}.`);
      }
    }
  });

  it("does not reference public.agents or public.issues, so deleting either never removes Room history", async () => {
    const h = await start();
    const fks = await h.sql<{ ref: string }>(
      `SELECT DISTINCT confrelid::regclass::text AS ref FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'f' AND n.nspname = $1`,
      [NS],
    );
    const refs = fks.map((r) => r.ref).sort();
    expect(refs).toEqual(
      [`${NS}.room_messages`, `${NS}.rooms`, `${NS}.rounds`, `${NS}.turns`, "companies"].sort(),
    );
  });

  it("removes a company's Room rows when the company is deleted", async () => {
    const h = await start();
    const a = await h.seedCompany();
    const b = await h.seedCompany();
    await seedRoomGraph(h, a);
    await seedRoomGraph(h, b);
    // The stub core tables do not cascade from companies; Room rows must not need agents to go first.
    await h.sql("DELETE FROM public.agents WHERE company_id = $1", [a.id]);
    await h.sql("DELETE FROM public.companies WHERE id = $1", [a.id]);
    for (const table of TABLES) {
      const left = await h.sql<{ company_id: string }>(`SELECT company_id FROM ${NS}.${table}`);
      expect(left.map((r) => r.company_id), table).toEqual([b.id]);
    }
  });
});

describe("rooms", () => {
  it("defaults the turn cap to 40 and the status to open", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await insertRoom(h.ctx.db, company.id, {
      title: "T",
      topic: "Topic",
      ownerUserId: company.members.owner.userId,
    });
    expect(room).toMatchObject<Partial<Room>>({
      companyId: company.id,
      title: "T",
      topic: "Topic",
      projectId: null,
      status: "open",
      maxTotalTurns: 40,
      decisionMd: null,
      closedAt: null,
    });
    expect(typeof room.createdAt).toBe("string");
  });

  it.each([0, 201])("rejects a turn cap of %i", async (cap) => {
    const h = await start();
    const company = await h.seedCompany();
    await expect(
      insertRoom(h.ctx.db, company.id, { title: "T", topic: "", ownerUserId: "u", maxTotalTurns: cap }),
    ).rejects.toThrow();
    await expect(
      h.sql(
        `INSERT INTO ${NS}.rooms (id, company_id, title, topic, owner_user_id, max_total_turns)
         VALUES (gen_random_uuid(), $1, 'T', '', 'u', $2)`,
        [company.id, cap],
      ),
    ).rejects.toThrow(/rooms_max_total_turns_check/);
  });

  it.each([1, 200])("accepts a turn cap of %i", async (cap) => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await insertRoom(h.ctx.db, company.id, { title: "T", topic: "", ownerUserId: "u", maxTotalTurns: cap });
    expect(room.maxTotalTurns).toBe(cap);
  });

  it("rejects an unknown status", async () => {
    const h = await start();
    const company = await h.seedCompany();
    await expect(
      h.sql(
        `INSERT INTO ${NS}.rooms (id, company_id, title, topic, owner_user_id, status)
         VALUES (gen_random_uuid(), $1, 'T', '', 'u', 'archived')`,
        [company.id],
      ),
    ).rejects.toThrow(/rooms_status_check/);
  });
});

describe("room_participants", () => {
  it("refuses a second active row for the same room and agent, and allows it after removal", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const db = h.ctx.db;
    const agentId = company.agents[0]!.id;
    const room = await insertRoom(db, company.id, { title: "T", topic: "", ownerUserId: "u" });

    const first = await insertParticipant(db, company.id, { roomId: room.id, agentId, addedByUserId: "u" });
    expect(first).not.toBeNull();
    // The data-access insert reports the conflict as null; a plain insert hits the index.
    expect(await insertParticipant(db, company.id, { roomId: room.id, agentId, addedByUserId: "u" })).toBeNull();
    await expect(
      h.sql(
        `INSERT INTO ${NS}.room_participants (id, company_id, room_id, agent_id, added_by_user_id)
         VALUES (gen_random_uuid(), $1, $2, $3, 'u')`,
        [company.id, room.id, agentId],
      ),
    ).rejects.toThrow(/room_participants_one_active_uq/);

    expect(await removeParticipant(db, company.id, room.id, agentId)).toBe(true);
    const again = await insertParticipant(db, company.id, { roomId: room.id, agentId, addedByUserId: "u" });
    expect(again).not.toBeNull();
    expect(again!.id).not.toBe(first!.id);
    expect((await listActiveParticipants(db, company.id, room.id)).map((p) => p.id)).toEqual([again!.id]);
  });

  it("counts active Participants only, in join order", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const db = h.ctx.db;
    const room = await insertRoom(db, company.id, { title: "T", topic: "", ownerUserId: "u" });
    for (const agent of company.agents) {
      await insertParticipant(db, company.id, { roomId: room.id, agentId: agent.id, addedByUserId: "u" });
    }
    expect(await countActiveParticipants(db, company.id, room.id)).toBe(3);
    await removeParticipant(db, company.id, room.id, company.agents[1]!.id);
    expect(await countActiveParticipants(db, company.id, room.id)).toBe(2);
    expect((await listActiveParticipants(db, company.id, room.id)).map((p) => p.agentId)).toEqual([
      company.agents[0]!.id,
      company.agents[2]!.id,
    ]);
  });

  it("refuses a Participant row whose room belongs to another company", async () => {
    const h = await start();
    const a = await h.seedCompany();
    const b = await h.seedCompany();
    const room = await insertRoom(h.ctx.db, a.id, { title: "T", topic: "", ownerUserId: "u" });
    await expect(
      insertParticipant(h.ctx.db, b.id, { roomId: room.id, agentId: b.agents[0]!.id, addedByUserId: "u" }),
    ).rejects.toThrow();
  });
});

describe("rounds", () => {
  it("allows at most one running or paused Round per Room; completed and stopped ones do not block", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const db = h.ctx.db;
    const { room, round, message } = await seedRoomGraph(h, company);
    const next = (seq: number) => ({
      roomId: room.id,
      seq,
      startedByUserId: "u",
      triggerMessageId: message.id,
      askAll: true,
      addressedAgentIds: [] as string[],
    });

    expect(round.status).toBe("running");
    expect(await insertRound(db, company.id, next(2))).toBeNull();
    await expect(
      h.sql(
        `INSERT INTO ${NS}.rounds (id, company_id, room_id, seq, started_by_user_id, trigger_message_id, status)
         VALUES (gen_random_uuid(), $1, $2, 2, 'u', $3, 'paused')`,
        [company.id, room.id, message.id],
      ),
    ).rejects.toThrow(/rounds_one_active_per_room_uq/);

    expect(await setRoundStatus(db, company.id, round.id, "paused")).toBe(true);
    expect(await insertRound(db, company.id, next(2))).toBeNull();

    expect(await setRoundStatus(db, company.id, round.id, "completed")).toBe(true);
    const second = await insertRound(db, company.id, next(2));
    expect(second).not.toBeNull();
    expect((await getActiveRound(db, company.id, room.id))?.id).toBe(second!.id);

    await setRoundStatus(db, company.id, second!.id, "stopped");
    expect(await getActiveRound(db, company.id, room.id)).toBeNull();
    const third = await insertRound(db, company.id, next(3));
    expect(third).not.toBeNull();
    expect((await listRounds(db, company.id, room.id)).map((r) => [r.seq, r.status])).toEqual([
      [1, "completed"],
      [2, "stopped"],
      [3, "running"],
    ]);
  });

  it("keeps the ordered addressed agent ids and the next sequence number", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const db = h.ctx.db;
    const { room, message } = await seedRoomGraph(h, company);
    expect(await nextRoundSeq(db, company.id, room.id)).toBe(2);
    const [x, y, z] = company.agents.map((a) => a.id);
    await setRoundStatus(db, company.id, (await getActiveRound(db, company.id, room.id))!.id, "completed");
    const round = await insertRound(db, company.id, {
      roomId: room.id,
      seq: 2,
      startedByUserId: "u",
      triggerMessageId: message.id,
      askAll: false,
      addressedAgentIds: [z!, x!, y!],
    });
    expect(round).toMatchObject<Partial<Round>>({ seq: 2, askAll: false, addressedAgentIds: [z!, x!, y!], endedAt: null });
    expect(await nextRoundSeq(db, company.id, room.id)).toBe(3);
  });

  it("sets the end time when a Round is stopped or completed", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const { round } = await seedRoomGraph(h, company);
    await setRoundStatus(h.ctx.db, company.id, round.id, "stopped");
    const stopped = await getRound(h.ctx.db, company.id, round.id);
    expect(stopped?.status).toBe("stopped");
    expect(typeof stopped?.endedAt).toBe("string");
  });

  it("refuses a repeated sequence number in one Room", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const { room, round, message } = await seedRoomGraph(h, company);
    await setRoundStatus(h.ctx.db, company.id, round.id, "completed");
    await expect(
      insertRound(h.ctx.db, company.id, {
        roomId: room.id,
        seq: 1,
        startedByUserId: "u",
        triggerMessageId: message.id,
        askAll: false,
        addressedAgentIds: [],
      }),
    ).rejects.toThrow();
  });
});

describe("turns", () => {
  it("refuses a second Turn for the same Round and agent", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const db = h.ctx.db;
    const { round, agent } = await seedRoomGraph(h, company);
    expect(await insertTurn(db, company.id, { roundId: round.id, agentId: agent.id, ord: 2 })).toBeNull();
    await expect(
      h.sql(
        `INSERT INTO ${NS}.turns (id, company_id, round_id, agent_id, ord) VALUES (gen_random_uuid(), $1, $2, $3, 2)`,
        [company.id, round.id, agent.id],
      ),
    ).rejects.toThrow(/turns_round_agent_uq/);
    // Another agent in the same Round is fine.
    const other = await insertTurn(db, company.id, { roundId: round.id, agentId: company.agents[1]!.id, ord: 2 });
    expect(other).toMatchObject({ status: "queued", outcome: null, skipReason: null, ord: 2 });
    expect((await listTurns(db, company.id, round.id)).map((t) => t.ord)).toEqual([1, 2]);
  });

  it("keeps outcome and skip reason consistent with the status", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const { turn } = await seedRoomGraph(h, company);
    const set = (fields: string) => h.sql(`UPDATE ${NS}.turns SET ${fields} WHERE id = $1`, [turn.id]);
    await expect(set("outcome = 'posted'")).rejects.toThrow(/turns_outcome_when_finished_check/);
    await expect(set("status = 'finished'")).rejects.toThrow(/turns_outcome_when_finished_check/);
    await expect(set("status = 'finished', outcome = 'posted', skip_reason = 'stopped'")).rejects.toThrow(
      /turns_skip_reason_check/,
    );
    await expect(set("status = 'finished', outcome = 'skipped'")).rejects.toThrow(/turns_skip_reason_check/);
    await expect(set("status = 'finished', outcome = 'skipped', skip_reason = 'tired'")).rejects.toThrow(
      /turns_skip_reason_check/,
    );
    await set("status = 'finished', outcome = 'skipped', skip_reason = 'not_invokable', host_message = 'Budget hit'");
    const after = await getTurn(h.ctx.db, company.id, turn.id);
    expect(after).toMatchObject({ status: "finished", outcome: "skipped", skipReason: "not_invokable", hostMessage: "Budget hit" });
  });

  it("finds a Turn by its run id within the company", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const { turn } = await seedRoomGraph(h, company);
    const runId = crypto.randomUUID();
    await h.sql(`UPDATE ${NS}.turns SET status = 'running', run_id = $1 WHERE id = $2`, [runId, turn.id]);
    expect((await findTurnByRunId(h.ctx.db, company.id, runId))?.id).toBe(turn.id);
    const other = await h.seedCompany();
    expect(await findTurnByRunId(h.ctx.db, other.id, runId)).toBeNull();
  });
});

describe("room_messages", () => {
  it("refuses a repeated idempotency key in one Room and accepts it in another", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const db = h.ctx.db;
    const { room, message } = await seedRoomGraph(h, company);
    const send = { authorKind: "user" as const, authorId: "u", body: "again", idempotencyKey: "send-1" };

    expect(await insertMessage(db, company.id, { roomId: room.id, ...send })).toBeNull();
    await expect(
      h.sql(
        `INSERT INTO ${NS}.room_messages (id, company_id, room_id, author_kind, author_id, body, idempotency_key)
         VALUES (gen_random_uuid(), $1, $2, 'user', 'u', 'x', 'send-1')`,
        [company.id, room.id],
      ),
    ).rejects.toThrow(/room_messages_room_idempotency_uq/);
    expect((await getMessageByIdempotencyKey(db, company.id, room.id, "send-1"))?.id).toBe(message.id);

    const otherRoom = await insertRoom(db, company.id, { title: "Other", topic: "", ownerUserId: "u" });
    const elsewhere = await insertMessage(db, company.id, { roomId: otherRoom.id, ...send });
    expect(elsewhere).toMatchObject({ roomId: otherRoom.id, idempotencyKey: "send-1", body: "again" });
  });

  it("allows any number of Messages without an idempotency key", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const db = h.ctx.db;
    const room = await insertRoom(db, company.id, { title: "T", topic: "", ownerUserId: "u" });
    for (const body of ["one", "two"]) {
      expect(await insertMessage(db, company.id, { roomId: room.id, authorKind: "user", authorId: "u", body })).not.toBeNull();
    }
    expect((await listMessages(db, company.id, room.id)).map((m) => m.body)).toEqual(["one", "two"]);
  });

  it("stores the Round, Turn and run id on agent Messages only", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const db = h.ctx.db;
    const { room, round, turn, agent } = await seedRoomGraph(h, company);
    const runId = crypto.randomUUID();
    const reply = await insertMessage(db, company.id, {
      roomId: room.id,
      authorKind: "agent",
      authorId: agent.id,
      body: "I disagree.",
      roundId: round.id,
      turnId: turn.id,
      runId,
    });
    expect(reply).toMatchObject({ authorKind: "agent", roundId: round.id, turnId: turn.id, runId });
    await expect(
      insertMessage(db, company.id, { roomId: room.id, authorKind: "user", authorId: "u", body: "x", roundId: round.id }),
    ).rejects.toThrow();
    await expect(
      insertMessage(db, company.id, { roomId: room.id, authorKind: "agent", authorId: agent.id, body: "x" }),
    ).rejects.toThrow();
  });
});

describe("work_links", () => {
  it("refuses a repeated (room, issue) pair", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const db = h.ctx.db;
    const { room, issueId } = await seedRoomGraph(h, company);
    expect(await insertWorkLink(db, company.id, { roomId: room.id, issueId, relation: "created", byUserId: "u" })).toBeNull();
    await expect(
      h.sql(
        `INSERT INTO ${NS}.work_links (id, company_id, room_id, issue_id, relation, by_user_id)
         VALUES (gen_random_uuid(), $1, $2, $3, 'created', 'u')`,
        [company.id, room.id, issueId],
      ),
    ).rejects.toThrow(/work_links_room_issue_uq/);
    // The same issue in another Room is a separate link.
    const other = await insertRoom(db, company.id, { title: "Other", topic: "", ownerUserId: "u" });
    expect(await insertWorkLink(db, company.id, { roomId: other.id, issueId, relation: "created", byUserId: "u" })).not.toBeNull();
    expect((await listWorkLinksForIssue(db, company.id, issueId)).map((l) => l.roomId).sort()).toEqual(
      [room.id, other.id].sort(),
    );
  });

  it("rejects an unknown relation", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const { room } = await seedRoomGraph(h, company);
    await expect(
      h.sql(
        `INSERT INTO ${NS}.work_links (id, company_id, room_id, issue_id, relation, by_user_id)
         VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'blocked', 'u')`,
        [company.id, room.id],
      ),
    ).rejects.toThrow(/work_links_relation_check/);
  });
});

describe("company scoping: a read with company A's id never returns company B's row", () => {
  async function twoCompanies() {
    const h = await start();
    const a = await h.seedCompany();
    const b = await h.seedCompany();
    const graphA = await seedRoomGraph(h, a);
    const graphB = await seedRoomGraph(h, b);
    return { h, db: h.ctx.db, a, b, graphA, graphB };
  }

  it("rooms", async () => {
    const { db, a, graphA, graphB } = await twoCompanies();
    expect(await getRoom(db, a.id, graphB.room.id)).toBeNull();
    expect((await getRoom(db, a.id, graphA.room.id))?.id).toBe(graphA.room.id);
    expect((await listRooms(db, a.id)).map((r) => r.id)).toEqual([graphA.room.id]);
  });

  it("room_participants", async () => {
    const { db, a, graphA, graphB } = await twoCompanies();
    expect(await listActiveParticipants(db, a.id, graphB.room.id)).toEqual([]);
    expect(await countActiveParticipants(db, a.id, graphB.room.id)).toBe(0);
    expect(await removeParticipant(db, a.id, graphB.room.id, graphB.agent.id)).toBe(false);
    expect((await listActiveParticipants(db, a.id, graphA.room.id)).map((p) => p.id)).toEqual([graphA.participant.id]);
  });

  it("room_messages", async () => {
    const { db, a, graphB } = await twoCompanies();
    expect(await getMessage(db, a.id, graphB.message.id)).toBeNull();
    expect(await listMessages(db, a.id, graphB.room.id)).toEqual([]);
    expect(await getMessageByIdempotencyKey(db, a.id, graphB.room.id, "send-1")).toBeNull();
  });

  it("rounds", async () => {
    const { db, a, graphB } = await twoCompanies();
    expect(await getRound(db, a.id, graphB.round.id)).toBeNull();
    expect(await getActiveRound(db, a.id, graphB.room.id)).toBeNull();
    expect(await listRounds(db, a.id, graphB.room.id)).toEqual([]);
    expect(await setRoundStatus(db, a.id, graphB.round.id, "stopped")).toBe(false);
    expect(await nextRoundSeq(db, a.id, graphB.room.id)).toBe(1);
  });

  it("turns", async () => {
    const { db, a, graphB } = await twoCompanies();
    expect(await getTurn(db, a.id, graphB.turn.id)).toBeNull();
    expect(await listTurns(db, a.id, graphB.round.id)).toEqual([]);
  });

  it("work_links", async () => {
    const { db, a, graphB } = await twoCompanies();
    expect(await listWorkLinks(db, a.id, graphB.room.id)).toEqual([]);
    expect(await listWorkLinksForIssue(db, a.id, graphB.issueId)).toEqual([]);
  });
});

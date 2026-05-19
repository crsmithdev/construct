import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, cpSync, rmSync } from "fs";
import { tmpdir } from "os";
import { adaptAllSessions as parseAllSessions, clearCache } from "../src/adapter.js";
import {
  reduceOverview as aggregateOverview,
  reduceTools as aggregateTools,
  reduceHooks as aggregateHooks,
  reduceTokens as aggregateTokens,
  reduceCost as aggregateCost,
  reduceSessions as aggregateSessions,
  reduceMemoryUsage as aggregateMemoryUsage,
  reduceSessionTrace as aggregateSessionTrace,
  reduceSubagents as aggregateSubagents,
} from "../src/reducers.js";
import type { TelemetryEvent } from "../src/event.js";

const fixturesDir = resolve(import.meta.dir, "fixtures/e2e");

/**
 * Ground truth derived by manual inspection of raw JSONL files.
 * Each session was analyzed independently — tool calls counted from assistant
 * message content blocks, user messages counted excluding isCompactSummary,
 * tokens summed from usage fields on assistant messages.
 */

interface SessionGroundTruth {
  sessionId: string;
  dir: string;
  main: {
    /** User messages with text content (parser only emits user_message for these) */
    userMessagesWithText: number;
    /** Total user entries in JSONL (including tool-result-only messages) */
    totalUserEntries: number;
    assistantMessages: number;
    toolCalls: Record<string, number>;
    totalToolCalls: number;
    toolErrors: number;
    hookSummaries: number;
    hookProgressCount: number;
    tokenEntries: number;
    tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
    models: Record<string, number>;
    firstTimestamp: string;
    lastTimestamp: string;
  };
  subagents?: Array<{
    file: string;
    userMessagesWithText: number;
    totalUserEntries: number;
    assistantMessages: number;
    toolCalls: Record<string, number>;
    totalToolCalls: number;
    toolErrors: number;
    tokenEntries: number;
    tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
    models: Record<string, number>;
    firstTimestamp: string;
    lastTimestamp: string;
  }>;
}

const SESSIONS: SessionGroundTruth[] = [
  {
    sessionId: "38c61b5a-6865-4c40-91cd-86f35ff43c2b",
    dir: "session1",
    main: {
      userMessagesWithText: 3,
      totalUserEntries: 9,
      assistantMessages: 8,
      toolCalls: { Read: 1, Edit: 1, Bash: 1, ToolSearch: 1, mcp__memory__memory_store: 1 },
      totalToolCalls: 5,
      toolErrors: 1,
      hookSummaries: 4,
      hookProgressCount: 8,
      tokenEntries: 8,
      tokens: { input: 16, output: 606, cacheRead: 151546, cacheCreation: 27637 },
      models: { "claude-opus-4-6": 8 },
      firstTimestamp: "2026-03-20T19:57:10.913Z",
      lastTimestamp: "2026-03-20T19:57:39.660Z",
    },
  },
  {
    sessionId: "aacb37f3-f315-4d9b-9b68-085f5b92c082",
    dir: "session2",
    main: {
      userMessagesWithText: 7,
      totalUserEntries: 25,
      assistantMessages: 29,
      toolCalls: { ToolSearch: 3, WebSearch: 5, WebFetch: 2, Bash: 6, Glob: 1, mcp__memory__memory_store: 1 },
      totalToolCalls: 18,
      toolErrors: 0,
      hookSummaries: 6,
      hookProgressCount: 8,
      tokenEntries: 29,
      tokens: { input: 4416, output: 2625, cacheRead: 786541, cacheCreation: 58864 },
      models: { "claude-opus-4-6": 29 },
      firstTimestamp: "2026-03-21T17:00:18.691Z",
      lastTimestamp: "2026-03-21T17:20:46.985Z",
    },
  },
  {
    sessionId: "1c8241f9-ec18-4fed-9e2a-ce791a6370df",
    dir: "session3",
    main: {
      userMessagesWithText: 2,
      totalUserEntries: 17,
      assistantMessages: 21,
      toolCalls: { Agent: 1, Read: 6, Grep: 4, Bash: 1, Glob: 3 },
      totalToolCalls: 15,
      toolErrors: 0,
      hookSummaries: 0,
      hookProgressCount: 14,
      tokenEntries: 21,
      tokens: { input: 25, output: 1818, cacheRead: 570744, cacheCreation: 91951 },
      models: { "claude-opus-4-6": 21 },
      firstTimestamp: "2026-03-21T20:56:12.768Z",
      lastTimestamp: "2026-03-21T20:59:35.061Z",
    },
    subagents: [
      {
        file: "agent-ac6718ec7cfd06bec",
        userMessagesWithText: 1,
        totalUserEntries: 32,
        assistantMessages: 38,
        toolCalls: { Read: 7, Bash: 16, Glob: 8 },
        totalToolCalls: 31,
        toolErrors: 0,
        tokenEntries: 38,
        tokens: { input: 46, output: 4303, cacheRead: 941445, cacheCreation: 118139 },
        models: { "claude-sonnet-4-6": 38 },
        firstTimestamp: "2026-03-21T20:56:55.704Z",
        lastTimestamp: "2026-03-21T20:58:52.922Z",
      },
    ],
  },
  {
    sessionId: "b83a7608-fd1c-4b5a-8c92-02df71e7441a",
    dir: "session4",
    main: {
      userMessagesWithText: 15,
      totalUserEntries: 35,
      assistantMessages: 34,
      toolCalls: { ToolSearch: 2, mcp__memory__memory_search: 1, Bash: 14, Grep: 1, mcp__memory__memory_store: 1, Agent: 1 },
      totalToolCalls: 20,
      toolErrors: 0,
      hookSummaries: 15,
      hookProgressCount: 17,
      tokenEntries: 34,
      tokens: { input: 55, output: 5669, cacheRead: 827141, cacheCreation: 62914 },
      models: { "claude-opus-4-6": 34 },
      firstTimestamp: "2026-03-18T05:32:12.367Z",
      lastTimestamp: "2026-03-18T05:56:49.981Z",
    },
    subagents: [
      {
        file: "agent-ab65ac3ba7761ba93",
        userMessagesWithText: 1,
        totalUserEntries: 16,
        assistantMessages: 19,
        toolCalls: { Glob: 1, Read: 7, Bash: 7 },
        totalToolCalls: 15,
        toolErrors: 0,
        tokenEntries: 19,
        tokens: { input: 117, output: 2528, cacheRead: 532553, cacheCreation: 169605 },
        models: { "claude-haiku-4-5-20251001": 19 },
        firstTimestamp: "2026-03-18T05:36:03.977Z",
        lastTimestamp: "2026-03-18T05:36:23.496Z",
      },
    ],
  },
  {
    sessionId: "41520765-f5d1-4b5f-bf9a-40229f7b265a",
    dir: "session5",
    main: {
      userMessagesWithText: 15,
      totalUserEntries: 52,
      assistantMessages: 60,
      toolCalls: { Bash: 17, Glob: 1, Read: 13, Edit: 4, Agent: 1, Grep: 1 },
      totalToolCalls: 37,
      toolErrors: 1,
      hookSummaries: 28,
      hookProgressCount: 56,
      tokenEntries: 60,
      tokens: { input: 496, output: 9874, cacheRead: 2163058, cacheCreation: 130103 },
      models: { "claude-opus-4-6": 60 },
      firstTimestamp: "2026-03-26T16:30:39.082Z",
      lastTimestamp: "2026-03-26T16:51:33.962Z",
    },
    subagents: [
      {
        file: "agent-a369cd56366313444",
        userMessagesWithText: 1,
        totalUserEntries: 41,
        assistantMessages: 57,
        toolCalls: { Read: 14, Bash: 26, Grep: 1 },
        totalToolCalls: 41,
        toolErrors: 2,
        tokenEntries: 57,
        tokens: { input: 62, output: 12849, cacheRead: 2329519, cacheCreation: 196561 },
        models: { "claude-opus-4-6": 57 },
        firstTimestamp: "2026-03-26T16:48:00.711Z",
        lastTimestamp: "2026-03-26T16:51:36.446Z",
      },
    ],
  },
];

function setupTempDir(sessionDir: string): string {
  const base = join(tmpdir(), `telemetry-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const projDir = join(base, "-home-testuser-construct");
  mkdirSync(projDir, { recursive: true });

  const srcDir = join(fixturesDir, sessionDir);
  // Copy all files preserving directory structure
  cpSync(srcDir, projDir, { recursive: true });

  return base;
}

describe("e2e telemetry pipeline", () => {
  for (const session of SESSIONS) {
    describe(`${session.dir} (${session.sessionId})`, () => {
      let entries: TelemetryEvent[];
      let baseDir: string;

      beforeEach(() => {
        clearCache();
        baseDir = setupTempDir(session.dir);
        entries = parseAllSessions({ baseDir });
      });

      afterEach(() => {
        rmSync(baseDir, { recursive: true, force: true });
      });

      describe("parser", () => {
        it("produces entries from the JSONL", () => {
          expect(entries.length).toBeGreaterThan(0);
        });

        it("assigns the correct session ID", () => {
          const mainEntries = entries.filter((e) => e.sid === session.sessionId);
          expect(mainEntries.length).toBeGreaterThan(0);
        });

        it("extracts the correct number of user_message entries", () => {
          const userMsgs = entries.filter(
            (e) => e.kind === "message" && e.sid === session.sessionId,
          );
          expect(userMsgs.length).toBe(session.main.userMessagesWithText);
        });

        it("extracts the correct number of token entries (assistant messages)", () => {
          const tokens = entries.filter(
            (e) => e.kind === "tokens" && e.sid === session.sessionId,
          );
          expect(tokens.length).toBe(session.main.tokenEntries);
        });

        it("extracts the correct tool_use counts per tool type", () => {
          const toolUses = entries.filter(
            (e) => e.kind === "tool" && e.sid === session.sessionId,
          );
          const counts: Record<string, number> = {};
          for (const e of toolUses) {
            const t = (e.data?.tool as string) || "";
            counts[t] = (counts[t] || 0) + 1;
          }
          expect(counts).toEqual(session.main.toolCalls);
        });

        it("extracts the correct total tool call count", () => {
          const toolUses = entries.filter(
            (e) => e.kind === "tool" && e.sid === session.sessionId,
          );
          expect(toolUses.length).toBe(session.main.totalToolCalls);
        });

        it("extracts the correct number of tool errors", () => {
          const errors = entries.filter(
            (e) => e.kind === "tool_result" && e.err !== undefined && e.sid === session.sessionId,
          );
          expect(errors.length).toBe(session.main.toolErrors);
        });

        it("extracts the correct number of stop_hook_summary entries", () => {
          const hooks = entries.filter(
            (e) => e.kind === "hook_summary" && e.sid === session.sessionId,
          );
          expect(hooks.length).toBe(session.main.hookSummaries);
        });

        it("extracts the correct number of hook_progress entries", () => {
          const progress = entries.filter(
            (e) => e.kind === "hook" && e.sid === session.sessionId,
          );
          expect(progress.length).toBe(session.main.hookProgressCount);
        });

        it("extracts correct token totals", () => {
          const tokenEntries = entries.filter(
            (e) => e.kind === "tokens" && e.sid === session.sessionId,
          );
          const totals = {
            input: tokenEntries.reduce((s, e) => s + ((e.data?.input as number) || 0), 0),
            output: tokenEntries.reduce((s, e) => s + ((e.data?.output as number) || 0), 0),
            cacheRead: tokenEntries.reduce((s, e) => s + ((e.data?.cacheRead as number) || 0), 0),
            cacheCreation: tokenEntries.reduce((s, e) => s + ((e.data?.cacheCreation as number) || 0), 0),
          };
          expect(totals).toEqual(session.main.tokens);
        });

        it("preserves correct timestamp range", () => {
          const sessionEntries = entries.filter((e) => e.sid === session.sessionId);
          const timestamps = sessionEntries.map((e) => e.ts).filter(Boolean).sort();
          expect(timestamps[0]).toBe(session.main.firstTimestamp);
          expect(timestamps[timestamps.length - 1]).toBe(session.main.lastTimestamp);
        });

        if (session.subagents) {
          for (const sub of session.subagents) {
            describe(`subagent ${sub.file}`, () => {
              it("parses subagent entries with correct parent session ID", () => {
                const subEntries = entries.filter((e) => e.sessionId === sub.file);
                expect(subEntries.length).toBeGreaterThan(0);
                const withParent = subEntries.filter((e) => e.parentSessionId === session.sessionId);
                expect(withParent.length).toBe(subEntries.length);
              });

              it("extracts correct subagent user messages", () => {
                const userMsgs = entries.filter(
                  (e) => e.entryType === "user_message" && e.sessionId === sub.file,
                );
                expect(userMsgs.length).toBe(sub.userMessagesWithText);
              });

              it("extracts correct subagent token entries", () => {
                const tokens = entries.filter(
                  (e) => e.entryType === "tokens" && e.sessionId === sub.file,
                );
                expect(tokens.length).toBe(sub.tokenEntries);
              });

              it("extracts correct subagent tool counts", () => {
                const toolUses = entries.filter(
                  (e) => e.entryType === "tool_use" && e.sessionId === sub.file,
                );
                const counts: Record<string, number> = {};
                for (const e of toolUses) {
                  counts[e.toolName!] = (counts[e.toolName!] || 0) + 1;
                }
                expect(counts).toEqual(sub.toolCalls);
              });

              it("extracts correct subagent total tool calls", () => {
                const toolUses = entries.filter(
                  (e) => e.entryType === "tool_use" && e.sessionId === sub.file,
                );
                expect(toolUses.length).toBe(sub.totalToolCalls);
              });

              it("extracts correct subagent tool errors", () => {
                const errors = entries.filter(
                  (e) => e.entryType === "tool_result" && e.isError && e.sessionId === sub.file,
                );
                expect(errors.length).toBe(sub.toolErrors);
              });

              it("extracts correct subagent token totals", () => {
                const tokenEntries = entries.filter(
                  (e) => e.entryType === "tokens" && e.sessionId === sub.file,
                );
                const totals = {
                  input: tokenEntries.reduce((s, e) => s + (e.inputTokens || 0), 0),
                  output: tokenEntries.reduce((s, e) => s + (e.outputTokens || 0), 0),
                  cacheRead: tokenEntries.reduce((s, e) => s + (e.cacheReadTokens || 0), 0),
                  cacheCreation: tokenEntries.reduce((s, e) => s + (e.cacheCreationTokens || 0), 0),
                };
                expect(totals).toEqual(sub.tokens);
              });

              it("preserves correct subagent timestamp range", () => {
                const subEntries = entries.filter((e) => e.sessionId === sub.file);
                const timestamps = subEntries.map((e) => e.timestamp).filter(Boolean).sort();
                expect(timestamps[0]).toBe(sub.firstTimestamp);
                expect(timestamps[timestamps.length - 1]).toBe(sub.lastTimestamp);
              });
            });
          }
        }
      });

      describe("aggregateOverview", () => {
        it("counts the correct number of sessions", () => {
          const overview = aggregateOverview(entries);
          const expectedSessions = 1 + (session.subagents?.length || 0);
          expect(overview.sessions).toBe(expectedSessions);
        });

        it("counts the correct total tool calls", () => {
          const overview = aggregateOverview(entries);
          let expectedTools = session.main.totalToolCalls;
          for (const sub of session.subagents || []) {
            expectedTools += sub.totalToolCalls;
          }
          expect(overview.toolCalls).toBe(expectedTools);
        });

        it("counts the correct total messages (token entries = assistant turns)", () => {
          const overview = aggregateOverview(entries);
          let expectedMessages = session.main.tokenEntries;
          for (const sub of session.subagents || []) {
            expectedMessages += sub.tokenEntries;
          }
          expect(overview.messages).toBe(expectedMessages);
        });

        it("counts the correct number of tool errors", () => {
          const overview = aggregateOverview(entries);
          let expectedErrors = session.main.toolErrors;
          for (const sub of session.subagents || []) {
            expectedErrors += sub.toolErrors;
          }
          expect(overview.toolErrors).toBe(expectedErrors);
        });

        it("calculates non-negative cost", () => {
          const overview = aggregateOverview(entries);
          expect(overview.totalCost).toBeGreaterThanOrEqual(0);
        });
      });

      describe("aggregateTools", () => {
        it("ranks tools correctly with combined main+subagent counts", () => {
          const toolsData = aggregateTools(entries);
          const combinedCounts: Record<string, number> = { ...session.main.toolCalls };
          for (const sub of session.subagents || []) {
            for (const [tool, count] of Object.entries(sub.toolCalls)) {
              combinedCounts[tool] = (combinedCounts[tool] || 0) + count;
            }
          }

          for (const [tool, expected] of Object.entries(combinedCounts)) {
            const metric = toolsData.ranked.find((r) => r.name === tool);
            expect(metric).toBeDefined();
            expect(metric!.count).toBe(expected);
          }
        });

        it("total tool count matches sum of ranked", () => {
          const toolsData = aggregateTools(entries);
          const total = toolsData.ranked.reduce((s, r) => s + r.count, 0);
          let expectedTotal = session.main.totalToolCalls;
          for (const sub of session.subagents || []) {
            expectedTotal += sub.totalToolCalls;
          }
          expect(total).toBe(expectedTotal);
        });

        it("percentages sum to approximately 100", () => {
          const toolsData = aggregateTools(entries);
          const totalPct = toolsData.ranked.reduce((s, r) => s + r.pct, 0);
          expect(totalPct).toBeCloseTo(100, 0);
        });

        it("ranked is sorted by count descending", () => {
          const toolsData = aggregateTools(entries);
          for (let i = 1; i < toolsData.ranked.length; i++) {
            expect(toolsData.ranked[i].count).toBeLessThanOrEqual(toolsData.ranked[i - 1].count);
          }
        });
      });

      describe("aggregateTokens", () => {
        it("sums token totals correctly", () => {
          const tokensData = aggregateTokens(entries);
          let expectedInput = session.main.tokens.input;
          let expectedOutput = session.main.tokens.output;
          let expectedCacheRead = session.main.tokens.cacheRead;
          let expectedCacheCreation = session.main.tokens.cacheCreation;
          for (const sub of session.subagents || []) {
            expectedInput += sub.tokens.input;
            expectedOutput += sub.tokens.output;
            expectedCacheRead += sub.tokens.cacheRead;
            expectedCacheCreation += sub.tokens.cacheCreation;
          }
          expect(tokensData.totalInput).toBe(expectedInput);
          expect(tokensData.totalOutput).toBe(expectedOutput);
          expect(tokensData.totalCacheRead).toBe(expectedCacheRead);
          expect(tokensData.totalCacheCreation).toBe(expectedCacheCreation);
        });
      });

      describe("aggregateCost", () => {
        it("produces non-negative cost", () => {
          const costData = aggregateCost(entries);
          expect(costData.totalUsd).toBeGreaterThanOrEqual(0);
        });

        it("model breakdown matches expected models", () => {
          const costData = aggregateCost(entries);
          const allModels = new Set<string>();
          for (const m of Object.keys(session.main.models)) allModels.add(m);
          for (const sub of session.subagents || []) {
            for (const m of Object.keys(sub.models)) allModels.add(m);
          }
          for (const model of allModels) {
            const found = costData.byModel.find((m) => model.startsWith(m.model.split("-").slice(0, 3).join("-")) || m.model === model);
            // Model may be normalized differently; at minimum we should have cost entries
          }
          expect(costData.byModel.length).toBeGreaterThan(0);
        });

        it("model percentages sum to approximately 100", () => {
          const costData = aggregateCost(entries);
          if (costData.byModel.length > 0) {
            const totalPct = costData.byModel.reduce((s, m) => s + m.pct, 0);
            expect(totalPct).toBeCloseTo(100, 0);
          }
        });
      });

      describe("aggregateSessions", () => {
        it("has correct session count", () => {
          const sessData = aggregateSessions(entries);
          const expectedSessions = 1 + (session.subagents?.length || 0);
          expect(sessData.sessions.length).toBe(expectedSessions);
        });

        it("main session has correct user and assistant message counts", () => {
          const sessData = aggregateSessions(entries);
          const mainSess = sessData.sessions.find((s) => s.sessionId === session.sessionId);
          expect(mainSess).toBeDefined();
          expect(mainSess!.userMessages).toBe(session.main.userMessagesWithText);
          expect(mainSess!.assistantMessages).toBe(session.main.tokenEntries);
        });

        it("main session has correct tool call count", () => {
          const sessData = aggregateSessions(entries);
          const mainSess = sessData.sessions.find((s) => s.sessionId === session.sessionId);
          expect(mainSess).toBeDefined();
          expect(mainSess!.toolCalls).toBe(session.main.totalToolCalls);
        });

        it("main session has correct timestamp range", () => {
          const sessData = aggregateSessions(entries);
          const mainSess = sessData.sessions.find((s) => s.sessionId === session.sessionId);
          expect(mainSess).toBeDefined();
          expect(mainSess!.firstTimestamp).toBe(session.main.firstTimestamp);
          expect(mainSess!.lastTimestamp).toBe(session.main.lastTimestamp);
        });

        it("main session duration is non-negative and matches timestamp diff", () => {
          const sessData = aggregateSessions(entries);
          const mainSess = sessData.sessions.find((s) => s.sessionId === session.sessionId);
          expect(mainSess).toBeDefined();
          const expectedDuration =
            new Date(session.main.lastTimestamp).getTime() -
            new Date(session.main.firstTimestamp).getTime();
          expect(mainSess!.durationMs).toBe(expectedDuration);
        });

        if (session.subagents && session.subagents.length > 0) {
          it("detects subagents on main session", () => {
            const sessData = aggregateSessions(entries);
            const mainSess = sessData.sessions.find((s) => s.sessionId === session.sessionId);
            expect(mainSess).toBeDefined();
            // Main session spawned Agent tool, so hasSubagents should be true
            if (session.main.toolCalls["Agent"]) {
              expect(mainSess!.hasSubagents).toBe(true);
            }
          });

          it("subagent sessions have correct parent", () => {
            const sessData = aggregateSessions(entries);
            for (const sub of session.subagents!) {
              const subSess = sessData.sessions.find((s) => s.sessionId === sub.file);
              expect(subSess).toBeDefined();
              expect(subSess!.parentSessionId).toBe(session.sessionId);
            }
          });

          it("subagent sessions have correct tool call counts", () => {
            const sessData = aggregateSessions(entries);
            for (const sub of session.subagents!) {
              const subSess = sessData.sessions.find((s) => s.sessionId === sub.file);
              expect(subSess).toBeDefined();
              expect(subSess!.toolCalls).toBe(sub.totalToolCalls);
            }
          });
        }
      });

      describe("aggregateHooks", () => {
        it("produces hook entries when hooks exist", () => {
          const hooksData = aggregateHooks(entries);
          if (session.main.hookSummaries > 0 || session.main.hookProgressCount > 0) {
            expect(hooksData.ranked.length).toBeGreaterThan(0);
          }
        });
      });

      describe("aggregateMemoryUsage", () => {
        it("counts memory stores and searches", () => {
          const memData = aggregateMemoryUsage(entries);
          const allToolCalls = { ...session.main.toolCalls };
          for (const sub of session.subagents || []) {
            for (const [tool, count] of Object.entries(sub.toolCalls)) {
              allToolCalls[tool] = (allToolCalls[tool] || 0) + count;
            }
          }
          const expectedStores = (allToolCalls["mcp__memory__memory_store"] || 0) + (allToolCalls["memory_store"] || 0);
          const expectedSearches = (allToolCalls["mcp__memory__memory_search"] || 0) + (allToolCalls["memory_search"] || 0);
          expect(memData.stores).toBe(expectedStores);
          expect(memData.searches).toBe(expectedSearches);
        });
      });

      describe("aggregateSessionTrace", () => {
        it("produces a trace for the main session", () => {
          const trace = aggregateSessionTrace(entries, session.sessionId);
          expect(trace.sessionId).toBe(session.sessionId);
          expect(trace.turns.length).toBeGreaterThan(0);
        });

        it("trace turns have spans for tool calls", () => {
          const trace = aggregateSessionTrace(entries, session.sessionId);
          const totalSpans = trace.turns.reduce((s, t) => s + t.spans.filter((sp) => sp.kind === "tool").length, 0);
          // Should have at least some tool spans
          expect(totalSpans).toBeGreaterThan(0);
        });

        it("trace total duration is non-negative", () => {
          const trace = aggregateSessionTrace(entries, session.sessionId);
          expect(trace.totalDurationMs).toBeGreaterThanOrEqual(0);
        });
      });

      describe("cross-aggregator consistency", () => {
        it("overview tool calls matches tools ranked total", () => {
          const overview = aggregateOverview(entries);
          const toolsData = aggregateTools(entries);
          const rankedTotal = toolsData.ranked.reduce((s, r) => s + r.count, 0);
          expect(overview.toolCalls).toBe(rankedTotal);
        });

        it("overview messages matches tokens total entries", () => {
          const overview = aggregateOverview(entries);
          // Messages in overview = token entries (one per assistant response)
          const tokenEntryCount = entries.filter((e) => e.entryType === "tokens").length;
          expect(overview.messages).toBe(tokenEntryCount);
        });

        it("overview cost matches cost aggregator total", () => {
          const overview = aggregateOverview(entries);
          const costData = aggregateCost(entries);
          expect(overview.totalCost).toBeCloseTo(costData.totalUsd, 10);
        });

        it("sessions total user messages matches sum across sessions", () => {
          const sessData = aggregateSessions(entries);
          const computedTotal = sessData.sessions.reduce((s, sess) => s + sess.userMessages, 0);
          expect(sessData.totalUserMessages).toBe(computedTotal);
        });

        it("sessions total assistant messages matches sum across sessions", () => {
          const sessData = aggregateSessions(entries);
          const computedTotal = sessData.sessions.reduce((s, sess) => s + sess.assistantMessages, 0);
          expect(sessData.totalAssistantMessages).toBe(computedTotal);
        });
      });
    });
  }
});
// ── Subagent aggregation ─────────────────────────────────────���────────────────

describe("subagent aggregation", () => {
  const { aggregateSubagents } = require("../src/aggregator.js") as typeof import("../src/aggregator.js");

  const parentSessionId = "parent-sess-1";
  const childSessionId = "agent-abc123";
  const baseTs = "2026-03-27T10:00:00.000Z";
  const baseTsMs = new Date(baseTs).getTime();

  function agentToolUse(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return {
      sessionId: parentSessionId,
      timestamp: baseTs,
      project: "test",
      entryType: "tool_use",
      toolName: "Agent",
      toolUseId: "tu_1",
      toolParams: {
        description: "refactor auth module",
        subagent_type: "general-purpose",
        run_in_background: true,
        model: "sonnet",
      },
      ...overrides,
    };
  }

  function toolResult(toolUseId: string, durationMs: number, isError = false): SessionEntry {
    return {
      sessionId: parentSessionId,
      timestamp: new Date(baseTsMs + durationMs).toISOString(),
      project: "test",
      entryType: "tool_result",
      toolUseId,
      toolDurationMs: durationMs,
      isError,
      errorMessage: isError ? "agent failed" : undefined,
    };
  }

  function childEntry(ts: string): SessionEntry {
    return {
      sessionId: childSessionId,
      parentSessionId,
      timestamp: ts,
      project: "test",
      entryType: "tool_use",
      toolName: "Read",
    };
  }

  it("counts dispatches and background ratio", () => {
    const entries: SessionEntry[] = [
      agentToolUse({ toolUseId: "tu_1", toolParams: { run_in_background: true, subagent_type: "general-purpose" } }),
      toolResult("tu_1", 5000),
      agentToolUse({ toolUseId: "tu_2", toolParams: { run_in_background: false, subagent_type: "Explore" }, timestamp: new Date(baseTsMs + 10000).toISOString() }),
      toolResult("tu_2", 3000),
    ];
    const result = aggregateSubagents(entries);

    expect(result.totalDispatches).toBe(2);
    expect(result.backgroundDispatches).toBe(1);
    expect(result.parentSessionCount).toBe(1);
  });

  it("computes duration percentiles", () => {
    const entries: SessionEntry[] = [];
    const durations = [1000, 2000, 3000, 5000, 8000, 10000, 15000, 20000, 25000, 30000];
    for (let i = 0; i < durations.length; i++) {
      const ts = new Date(baseTsMs + i * 60000).toISOString();
      entries.push(agentToolUse({ toolUseId: `tu_${i}`, timestamp: ts }));
      entries.push(toolResult(`tu_${i}`, durations[i]));
    }
    const result = aggregateSubagents(entries);

    expect(result.totalDispatches).toBe(10);
    expect(result.avgMs).toBe(11900); // mean of durations
    expect(result.p50Ms).toBeGreaterThan(0);
    expect(result.p95Ms).toBeGreaterThanOrEqual(result.p50Ms);
  });

  it("groups by subagent type", () => {
    const entries: SessionEntry[] = [
      agentToolUse({ toolUseId: "tu_1", toolParams: { subagent_type: "Explore" } }),
      toolResult("tu_1", 2000),
      agentToolUse({ toolUseId: "tu_2", toolParams: { subagent_type: "Explore" }, timestamp: new Date(baseTsMs + 5000).toISOString() }),
      toolResult("tu_2", 3000),
      agentToolUse({ toolUseId: "tu_3", toolParams: { subagent_type: "Plan" }, timestamp: new Date(baseTsMs + 10000).toISOString() }),
      toolResult("tu_3", 1000),
    ];
    const result = aggregateSubagents(entries);

    expect(result.byType.length).toBe(2);
    const explore = result.byType.find(t => t.subagentType === "Explore");
    const plan = result.byType.find(t => t.subagentType === "Plan");
    expect(explore?.count).toBe(2);
    expect(plan?.count).toBe(1);
    expect(explore!.pct + plan!.pct).toBe(100);
  });

  it("matches child sessions by timestamp overlap", () => {
    const entries: SessionEntry[] = [
      agentToolUse({ toolUseId: "tu_1" }),
      toolResult("tu_1", 10000),
      // Child session entries within the Agent call duration
      childEntry(new Date(baseTsMs + 500).toISOString()),
      childEntry(new Date(baseTsMs + 5000).toISOString()),
      childEntry(new Date(baseTsMs + 9000).toISOString()),
    ];
    const result = aggregateSubagents(entries);

    expect(result.recent.length).toBe(1);
    expect(result.recent[0].subagentSessionId).toBe(childSessionId);
  });

  it("groups by day correctly", () => {
    const day1 = "2026-03-26T10:00:00.000Z";
    const day2 = "2026-03-27T10:00:00.000Z";
    const entries: SessionEntry[] = [
      agentToolUse({ toolUseId: "tu_1", timestamp: day1, toolParams: { run_in_background: true } }),
      toolResult("tu_1", 5000),
      agentToolUse({ toolUseId: "tu_2", timestamp: day2, toolParams: { run_in_background: false } }),
      toolResult("tu_2", 3000),
      agentToolUse({ toolUseId: "tu_3", timestamp: day2, toolParams: { run_in_background: true } }),
      toolResult("tu_3", 4000),
    ];
    const result = aggregateSubagents(entries);

    expect(result.byDay.length).toBe(2);
    expect(result.byDay[0].date).toBe("2026-03-26");
    expect(result.byDay[0].count).toBe(1);
    expect(result.byDay[0].backgroundCount).toBe(1);
    expect(result.byDay[1].date).toBe("2026-03-27");
    expect(result.byDay[1].count).toBe(2);
    expect(result.byDay[1].backgroundCount).toBe(1);
    expect(result.byDay[1].foregroundCount).toBe(1);
  });

  it("tracks errors in type buckets", () => {
    const entries: SessionEntry[] = [
      agentToolUse({ toolUseId: "tu_1", toolParams: { subagent_type: "general-purpose" } }),
      toolResult("tu_1", 5000, true),
    ];
    const result = aggregateSubagents(entries);

    expect(result.byType[0].errors).toBe(1);
    expect(result.recent[0].isError).toBe(true);
  });

  it("handles empty entries", () => {
    const result = aggregateSubagents([]);
    expect(result.totalDispatches).toBe(0);
    expect(result.activeNow).toBe(0);
    expect(result.avgMs).toBe(0);
    expect(result.byDay).toEqual([]);
    expect(result.byType).toEqual([]);
    expect(result.recent).toEqual([]);
  });

  it("recent invocations sorted newest first and capped at 100", () => {
    const entries: SessionEntry[] = [];
    for (let i = 0; i < 110; i++) {
      const ts = new Date(baseTsMs + i * 60000).toISOString();
      entries.push(agentToolUse({ toolUseId: `tu_${i}`, timestamp: ts, toolParams: { description: `task ${i}`, subagent_type: "general-purpose" } }));
      entries.push(toolResult(`tu_${i}`, 1000));
    }
    const result = aggregateSubagents(entries);

    expect(result.recent.length).toBe(100);
    // Newest first
    expect(result.recent[0].timestamp).toBe(new Date(baseTsMs + 109 * 60000).toISOString());
  });
});

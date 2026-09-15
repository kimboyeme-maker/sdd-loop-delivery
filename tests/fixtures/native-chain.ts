import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { admissionFixture } from "./admission";
import { initLoop } from "../../scripts/controllers/init.controller";
import { authBootstrap } from "../../scripts/controllers/auth-bootstrap.controller";
import { transition } from "../../scripts/controllers/transition.controller";
import { recordEvent } from "../../scripts/controllers/record.controller";
import { dispatch } from "../../scripts/controllers/dispatch.controller";
import { runBootstrapProcesses } from "../../scripts/controllers/bootstrap-process";
import { contextRead } from "../../scripts/controllers/read-only.controller";
import {
  agentStartReceipt,
  type StartExtras,
} from "../../scripts/controllers/agent-start-receipt.controller";
import { agentRecord } from "../../scripts/controllers/agent-record.controller";
import { testRun } from "../../scripts/controllers/test-run.controller";
import { requirementUpdate } from "../../scripts/controllers/requirement.controller";
import { productSnapshot } from "../../scripts/helpers/worktree-candidate";

type Item = Record<string, unknown>;
export const COORDINATOR = "coordinator";
/** Process variables the chain sets and restores; role credentials come from minted files. */
const ENV_KEYS = ["SDD_LOOP_COORDINATOR_TOKEN", "SDD_LOOP_AGENT_TOKEN_FILE", "SDD_LOOP_CAPABILITY_DIR"];

export type NativeChainOptions = Readonly<{
  /** Execution packets derived from the fixture packet; later packets depend on the previous one. */
  packetIds?: readonly string[];
  /** Normative contract written into the SDD; defaults to the single-package fixture. */
  contract?: Item;
  /** Complete admission payload; its first modification package receives the product file. */
  admission?: Item;
}>;

/**
 * Drive the real native controllers through the current phase machine.
 * Role identities and host receipts are synthetic; product bytes and checks are real.
 * Callers must invoke `restore()` in a finally block to reset process tokens.
 */
export function createNativeChain(root: string, options: NativeChainOptions = {}) {
  const workspace = join(root, "product"),
    sdd = join(root, "task.md");
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SDD_LOOP_COORDINATOR_TOKEN = COORDINATOR;
  process.env.SDD_LOOP_CAPABILITY_DIR = join(root, "capabilities");
  /** Lease ID → minted role credential, read back from the controller's private file. */
  const tokens = new Map<string, string>();
  const fixture = admissionFixture(".");
  const contract: Item = structuredClone(options.contract ?? fixture.contract);
  const admission: Item = structuredClone(options.admission ?? fixture.payload);
  const packetIds = options.packetIds ?? ["PC01"];
  if (options.packetIds)
    admission.execution_packets = packetIds.map((id, index) => ({
      ...(admission.execution_packets as Item[])[0],
      id,
      ...(index ? { depends_on_packet_ids: [packetIds[index - 1]] } : {}),
    }));
  const owner = (admission.modification_packages as string[])[0]!;
  const productFile = owner === "." ? "value.ts" : `${owner}/value.ts`;
  const semanticReview = {
    semantic_ids: ((admission.semantic_ownership as Item).items as Item[]).map((item) => item.id),
    evidence: ["one value producer"],
    unresolved_conflicts: [],
  };
  const state = (): Item => JSON.parse(readFileSync(sdd + ".loop.json", "utf8"));
  const phase = () => String(state().phase);
  const advance = (...targets: string[]) => {
    for (const to of targets) transition(sdd, "coordinator", phase(), "v1", to, COORDINATOR);
  };
  let candidate: Item = {};
  /** Controller-measured test_run event IDs taken on the current candidate. */
  let lastRuns: string[] = [];
  /** The latest Architect run; executed verification checks cite exactly this measurement. */
  let lastArchitectRun: { eventId: string; duration_seconds: number; outcome: string } | undefined;

  /** Dispatch, bootstrap in three processes and record a read-backed start. */
  const start = (
    role: "operator" | "architect",
    packet?: string,
    scope: readonly string[] = [owner],
    agentId: string = role,
    extras: StartExtras = {},
  ) => {
    const current = phase();
    const lease = dispatch(
      sdd,
      "coordinator",
      current,
      "v1",
      role,
      agentId,
      1,
      5,
      scope,
      "fixture assignment",
      COORDINATOR,
      { ...(role === "operator" ? { worktreeRoot: workspace } : {}), ...(packet ? { packet } : {}) },
    );
    // The runtime receives only the locator; the Coordinator never supplies the token.
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = lease.capabilityFile;
    tokens.set(lease.leaseId, readFileSync(lease.capabilityFile, "utf8"));
    runBootstrapProcesses(sdd, agentId, current, "v1");
    const pages = join(root, `${role}-pages.json`);
    writeFileSync(pages, JSON.stringify(contextRead(sdd, 0, 65536)));
    agentStartReceipt(
      sdd,
      role,
      agentId,
      lease.leaseId,
      pages,
      "Inspect the fixture, run its result check, and stop on a failing result.",
      current,
      "v1",
      COORDINATOR,
      undefined,
      extras,
    );
    return lease.leaseId;
  };
  const record = (
    role: "operator" | "architect",
    leaseId: string,
    type: string,
    payload: Item,
    agentId: string = role,
  ) =>
    agentRecord(
      sdd,
      role,
      agentId,
      leaseId,
      phase(),
      "v1",
      type,
      payload,
      tokens.get(leaseId),
      COORDINATOR,
    ).eventId;
  const bindings = () => ({
    candidate_id: candidate.candidate_id,
    environment_fingerprint: candidate.environment_fingerprint,
    manifest_sha256: candidate.manifest_sha256,
    worktree_fingerprint: candidate.worktree_fingerprint,
  });

  return {
    sdd,
    workspace,
    admission,
    contract,
    productFile,
    state,
    phase,
    advance,
    start,
    record,
    bindings,
    token: (leaseId: string) => tokens.get(leaseId),
    candidate: () => candidate,
    /** Run the real product check against current bytes. */
    check() {
      return Bun.spawnSync([process.execPath, join(workspace, dirname(productFile), "check.ts")])
        .exitCode;
    },
    /** Initialize a git product and reach CONTRACT_DRAFT without admission. */
    setup() {
      mkdirSync(join(workspace, dirname(productFile)), { recursive: true });
      Bun.spawnSync(["git", "init", "-q"], { cwd: workspace });
      writeFileSync(join(workspace, productFile), "export const value = 1;");
      writeFileSync(
        join(workspace, dirname(productFile), "check.ts"),
        "import {value} from './value'; if (value !== 2) throw Error('wrong value');",
      );
      writeFileSync(
        sdd,
        `<!-- sdd-contract:start -->\n\`\`\`json\n${JSON.stringify(contract)}\n\`\`\`\n<!-- sdd-contract:end -->`,
      );
      initLoop(sdd, 4);
      authBootstrap(sdd, "DISCOVER", "v1", "yes", COORDINATOR);
      advance("ARCHITECT", "CONTRACT_DRAFT");
    },
    admit(payload: Item = admission) {
      return recordEvent(sdd, "coordinator", phase(), "v1", "contract_admission", payload, COORDINATOR);
    },
    /** Move an admitted contract to readback and accept the admitted route. */
    readback(packet?: string) {
      if (phase() !== "OPERATOR_READBACK") advance("CONTRACT_ADMITTED", "OPERATOR_READBACK");
      const leaseId = start("operator", packet);
      record("operator", leaseId, "contract_readback", {
        assessment: "ACCEPT",
        route_assessment: "SUPPORTED",
        independent_checks: ["fixture value producer inspected"],
        unresolved_unknowns: [],
        semantic_ownership_review: semanticReview,
        execution_packet_ids: packet ? [packet] : [...packetIds],
      });
      return leaseId;
    },
    /** Write product bytes and submit the complete implementation manifest. */
    implement(
      leaseId: string,
      content: string,
      packet?: string,
      id = "candidate",
      changedPackages: readonly string[] = [owner],
    ) {
      writeFileSync(join(workspace, productFile), content);
      const changes = [{ path: productFile, action: "MODIFIED" }];
      candidate = {
        candidate_id: id,
        environment_fingerprint: "fixture-bun",
        changes,
        manifest_sha256: createHash("sha256").update(JSON.stringify(changes)).digest("hex"),
        worktree_fingerprint: productSnapshot(sdd, workspace).fingerprint,
      };
      return record("operator", leaseId, "implementation", {
        candidate,
        execution_packet_ids: packet ? [packet] : [...packetIds],
        changed_packages: [...changedPackages],
        test_changes: [],
      });
    },
    /** Run the real product check through the controller timer and remember its event. */
    runTests(
      leaseId: string,
      acceptanceIds: readonly string[] = admission.acceptance_ids as string[],
      argv: readonly string[] = [process.execPath, join(dirname(productFile), "check.ts")],
    ) {
      const result = testRun(
        sdd,
        "operator",
        "operator",
        leaseId,
        phase(),
        "v1",
        acceptanceIds,
        argv,
        undefined,
        tokens.get(leaseId),
        COORDINATOR,
      );
      lastRuns = [...lastRuns, result.eventId];
      return result;
    },
    /** Run the product check as the Architect on an isolated copy through the controller timer. */
    architectRun(
      leaseId: string,
      acceptanceIds: readonly string[] = admission.acceptance_ids as string[],
      agentId = "architect",
      token = tokens.get(leaseId),
    ) {
      const copy = join(root, `architect-copy-${leaseId}`);
      cpSync(workspace, copy, { recursive: true });
      const result = testRun(
        sdd,
        "architect",
        agentId,
        leaseId,
        phase(),
        "v1",
        acceptanceIds,
        [process.execPath, join(dirname(productFile), "check.ts")],
        copy,
        token,
        COORDINATOR,
      );
      lastArchitectRun = result;
      return result;
    },
    selfCheckPayload(result = "PASS", runIds: readonly string[] = lastRuns): Item {
      return {
        ...bindings(),
        result,
        handoff_status: result === "PASS" ? "READY_FOR_ARCHITECT" : "NOT_READY",
        semantic_ownership_review: semanticReview,
        execution_packet_ids: [...packetIds],
        test_run_event_ids: [...runIds],
        candidate_receipt: {
          oracle_sensitivity: {
            status: "NOT_APPLICABLE",
            acceptance_ids: [],
            evidence: ["fixture acceptance declares no guard perturbation"],
          },
          environment_integrity: {
            status: "PASS",
            before_fingerprint: "fixture-bun",
            after_fingerprint: "fixture-bun",
            unexpected_drift: [],
            evidence: ["same Bun runtime"],
          },
          modification_scope: {
            status: "PASS",
            changed_packages: [owner],
            changed_paths: [productFile],
            unauthorized_changes: [],
            evidence: [`worktree delta contains ${productFile} only`],
          },
        },
      };
    },
    /** Architect PASS whose checks copy the admitted acceptance method, oracle and environment. */
    verificationPayload(): Item {
      const ids = admission.acceptance_ids as string[];
      return {
        ...bindings(),
        result: "PASS",
        requirement_ids: admission.requirement_ids,
        acceptance_ids: ids,
        changed_packages: [owner],
        semantic_ownership_review: semanticReview,
        execution_packet_ids: [...packetIds],
        checks: (contract.acceptance as Item[])
          .filter((item) => ids.includes(String(item.id)))
          .map((item) => ({
            method: item.method,
            oracle: item.oracle,
            environment: item.environment,
            outcome: lastArchitectRun?.outcome ?? "PASS",
            duration_seconds: lastArchitectRun?.duration_seconds ?? 2,
            ...(lastArchitectRun ? { test_run_event_id: lastArchitectRun.eventId } : {}),
            acceptance_ids: [item.id],
            packages: item.packages,
          })),
      };
    },
    /** Start an Architect, measure the check, and record a verdict; `patch` overrides payload fields. */
    verify(patch?: Item) {
      const leaseId = start("architect");
      this.architectRun(leaseId);
      return record("architect", leaseId, "verification", { ...this.verificationPayload(), ...patch });
    },
    /** Drive readback, implementation, READY self-check and handoff into ARCHITECT_VERIFY. */
    toArchitectVerify() {
      this.admit();
      const leaseId = this.readback();
      advance("READBACK_APPROVED", "IMPLEMENTING");
      this.implement(leaseId, "export const value = 2;");
      advance("OPERATOR_SELF_CHECK");
      this.runTests(leaseId);
      record("operator", leaseId, "self_check", this.selfCheckPayload());
      advance("ARCHITECT_VERIFY");
    },
    markVerified(evidence: string, id = "XQ01") {
      return requirementUpdate(
        sdd,
        "coordinator",
        phase(),
        "v1",
        id,
        "verified",
        evidence,
        undefined,
        undefined,
        undefined,
        undefined,
        COORDINATOR,
      );
    },
    restore() {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    },
  };
}

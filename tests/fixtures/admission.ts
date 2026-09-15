import { recordEvent } from "../../scripts/controllers/record.controller";
import { roleRuntime } from "../../scripts/config/host";

/** Complete synthetic design/admission input for controller tests, not host or product proof. */
export function admissionFixture(owner = "packages/app") {
  const requirement_ids = ["XQ01"],
    acceptance_ids = ["YS01"],
    packages = [owner];
  const contract = {
    protocol: "sdd-loop-delivery/v1",
    revision: "v1",
    lineage: { mode: "fresh" },
    ownership: { packages, approval_authority: "fixture user scope" },
    requirements: [
      { id: "XQ01", kind: "must-ship" as const, title: "Return two", acceptance: acceptance_ids },
    ],
    acceptance: [
      {
        id: "YS01",
        requirement_ids,
        packages,
        method: "fixture-check",
        oracle: "value equals two",
        environment: "isolated fixture",
        claim: {
          id: "CL01",
          statement: "value equals two",
          dimension: "BEHAVIOR",
          quantifier: "SINGLE",
        },
        execution: {
          isolation: "INDEPENDENT",
          timeout_seconds: 30,
          readiness_oracle: "fixture ready",
          state_boundary: "fresh fixture",
          evidence_boundary: "fixture-result",
          blocking_acceptance_ids: [],
        },
      },
    ],
  };
  const packet = {
    id: "PC01",
    outcome: "return two",
    requirement_ids,
    acceptance_ids,
    preconditions: ["fixture available"],
    causal_scope: ["value"],
    stop_or_escalate: ["fixture differs"],
    test_budget: { minutes: 5, max_new_test_files: 1 },
  };
  const payload = {
    decision: "ADMIT",
    requirement_ids,
    acceptance_ids,
    modification_packages: packages,
    execution_packets: [packet],
    round_outcome: "return two",
    rollback_or_containment: "restore only fixture change",
    top_failure_mode: "wrong value",
    early_falsifier: "fixture returns wrong value",
    problem_evidence: ["fixture observation"],
    downstream_impacts: ["fixture consumer"],
    conventional_route: {
      summary: "change value producer",
      applicability: "FIT",
      evidence: "fixture source",
    },
    selected_route_id: "RT01",
    route_options: [{ id: "RT01", disposition: "SELECTED", evidence: "fixture source" }],
    responsibility: {
      decision_owner: "coordinator",
      implementation_owner: "operator",
      verification_owner: "architect",
      approval_authority: "fixture user scope",
    },
    workload: { affected_packages: packages, verification_surfaces: ["value"], confidence: "HIGH" },
    difficulty: { level: "ROUTINE", drivers: ["local value"] },
    unknowns: [],
    fact_closure: {
      lineage_mode: "fresh",
      unresolved_fact_ids: [],
      inherited_obligations: [],
      facts: [
        {
          id: "FT01",
          claim: "fixture route can be checked",
          status: "CONFIRMED_PASS",
          requirement_ids,
          acceptance_ids,
          packages,
          claim_ids: ["CL01"],
          evidence_kind: "TEST_RESULT",
          source: {
            kind: "COMMAND",
            reference: "fixture-check",
            observed: "controlled fixture probe",
          },
        },
      ],
    },
    assumptions_checked: [
      {
        id: "AS01",
        claim: "route executable",
        evidence: "fixture probe",
        category: "ROUTE_FEASIBILITY",
        status: "PROVEN",
        evidence_fact_ids: ["FT01"],
      },
    ],
    early_falsifier_result: {
      outcome: "SURVIVED",
      method: "fixture-check",
      failure_condition: "cannot observe value",
      observed_result: "value observable",
      target_assumption_ids: ["AS01"],
      requirement_ids,
      acceptance_ids,
      evidence_fact_ids: ["FT01"],
      evidence: ["fixture probe"],
    },
    claim_dispositions: [
      {
        claim_id: "CL01",
        disposition: "IMPLEMENTATION_REQUIRED",
        fact_ids: [],
        packet_ids: ["PC01"],
        evidence: ["change fixture value"],
      },
    ],
    verification_scope: {
      mode: "CAUSAL_CLOSURE",
      external_failure_policy: "NON_BLOCKING_UNLESS_CAUSAL_OR_ORACLE_MASKING",
      surfaces: [
        {
          id: "VS01",
          target: "value",
          causal_basis: "value producer",
          method: "fixture-check",
          requirement_ids,
          acceptance_ids,
          packages,
        },
      ],
      workspace_wide_gate: { disposition: "NOT_APPLICABLE", evidence: [] },
    },
    semantic_ownership: {
      cross_clause_evidence: ["one value producer"],
      items: [
        {
          id: "SO01",
          subject: "value",
          authoritative_owner: "fixture",
          requirement_ids,
          evidence: ["fixture source"],
          participants: [],
        },
      ],
      primitive_search_evidence: ["reuse fixture"],
      primitive_decisions: [],
      unresolved_conflicts: [],
    },
    must_ship_decision_closure: {
      requirement_ids,
      decision_requirement_ids: [],
      unresolved_decisions: [],
      dimensions: [
        "SEMANTIC_OWNER",
        "DEPENDENCY_DIRECTION",
        "PUBLIC_CONTRACT",
        "DIRECT_CONSUMERS",
        "USER_AUTHORITY",
      ].map((dimension) => ({
        dimension,
        disposition: dimension === "USER_AUTHORITY" ? "NOT_REQUIRED" : "CLOSED",
        evidence: ["fixture scope review"],
      })),
    },
    sdd_convergence_review: {
      sdd_revision: "v1",
      independent_result: "PASS",
      reviewed_acceptance_ids: acceptance_ids,
      evidence: ["fixture route review"],
      unresolved_information_questions: [],
      pending_authority_confirmations: [],
      route_critical_unknowns: [],
      blocking_findings: [],
      material_findings: [],
      acceptance_topology: {
        method: "fixture-check",
        failure_condition: "wrong value",
        observed_result: "fixture observable",
        evidence: ["fixture probe"],
      },
    },
  };
  Object.assign(payload, {
    artifact_custody: {
      items: [],
      absence_evidence: ["fixture has no signed, generated or protected artifact"],
    },
    coordinator_runtime: {
      model: roleRuntime("coordinator").spawn_model,
      reasoning_effort: roleRuntime("coordinator").reasoning_effort,
      evidence: "fixture host spawn receipt",
    },
  });
  const source = `<!-- sdd-contract:start -->\n\`\`\`json\n${JSON.stringify(contract)}\n\`\`\`\n<!-- sdd-contract:end -->`;
  return { contract, payload, source };
}

/** Exercise the real admission producer; never seed unsigned or bypassed grants. */
export function admitFixture(sdd: string, token: string, owner = "packages/app") {
  return recordEvent(
    sdd,
    "coordinator",
    "DISCOVER",
    "v1",
    "contract_admission",
    admissionFixture(owner).payload,
    token,
  );
}

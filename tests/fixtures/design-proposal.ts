import {DESIGN_REVIEW_DIMENSIONS,DESIGN_PRESERVATION_BOUNDARIES} from "../../scripts/config/constants";
/** A complete bounded example for proposal transport tests, not proof of design quality. */
export function designProposalFixture(){return {
 proposal_id:"DP01",materiality:"MATERIAL",trigger:"Cancellation completes before ownership transfer",
 problem_evidence:["race trace"],root_cause:"Completion is emitted before custody is released",
 independent_checks:["replayed both callback orders"],current_route_counterexamples:["cancel during transfer"],
 state_and_evidence_invariants:["completion follows release"],packet_and_dependency_invariants:["release producer precedes notification"],falsifiers:["force delayed release"],
 authority_classification:"COORDINATOR_OWNED",unknowns:[],
 claims:DESIGN_REVIEW_DIMENSIONS.map((dimension,index)=>({id:"CL0"+(index+1),dimension,statement:"Preserve "+dimension,evidence:["trace and source"],falsifier:"Reverse release ordering"})),
 route_options:[{id:"RT01",summary:"Complete after release",evidence:"trace",tradeoffs:"wait for release"}],recommended_route_id:"RT01",
 contract_preservation:Object.fromEntries(DESIGN_PRESERVATION_BOUNDARIES.map(key=>[key,{status:"PRESERVED",evidence:["unchanged contract"]}]))
};}

/** Complete convergence payload; caller supplies the exact proposal event identity. */
export function designResolutionFixture(proposal_event_id="EVT-proposal"){return {proposal_event_id,decision:"CONVERGED",evidence:["replayed proposed route"],selected_route_id:"RT01",rejected_failure_modes:["early notification"],falsifier_evidence:["delayed release remains ordered"],authority_classification:"COORDINATOR_OWNED",unknowns:[],evidence_review:{architect_claim_ids:["CL-STATE"],claim_type:"PROPOSED_ROUTE",decision_impact:"ROUTE_CHANGING",method:"COUNTERFACTUAL",decision_flip_condition:"delayed release reorders callbacks",result:"CONFIRMED",evidence:["counterfactual replay"]},review_coverage:DESIGN_REVIEW_DIMENSIONS.map(dimension=>({dimension,result:"PASS",evidence:["source and counterexample replay"]}))};}

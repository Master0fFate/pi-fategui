# Native task scheduling with existing SDK child sessions

This is the production native adoption slice. `MultiProjectPiRuntimeDeps` accepts a
profile-owned `nativeWorkflowSchedulerFactory`, passed through PiRuntimeService and
AgentWorkflowCoordinator. New workflows then persist an explicit native scheduler
identity in their existing parent JSONL workflow snapshot. Existing legacy graphs
retain their old execution path; restored native graphs cannot resume via it.
There is no automatic fallback after native storage/open/runtime failure.

## Replaced authority

For a native graph, `SubagentWorkflowEngine.execute` bypasses its legacy
`running` promise map and `while` admission loop. An upstream native root Task owns
one upstream child Task per workflow node. Its durable checkpoint stores child
TaskIds, and native terminal receipts determine dependency readiness, concurrency
availability, skip/run policy, cancellation and joins. The root uses upstream
invocation-bound task waits, including first-settled waits to refill capacity.
Fate's workflow/node objects are UI/policy projections, never admission authority.
Final projection is verified against the complete native graph result.

The child task commits its effect checkpoint before calling the existing
`AgentWorkflowCoordinator.launchNode` / Agent Team SDK path. Fate keeps child
permission and worktree policy, approved skills, original ToolDefinitions and
ApprovalGate behavior, model/routing choices, result envelopes, budget advice,
notifications, transcript/session identity, and checkout leases. No Harness model
generation is used in this slice: there is no second conversation transcript or
model loop. Native task receipts contain the confirmed SDK SubagentRun record;
original SDK JSONL remains the conversation source.

Known no-effect Team rejections carry an explicit trusted sentinel only from the
normalization/policy/model-availability/resource-read phase before node insertion,
workspace provisioning, or SDK child creation. These become ordinary native error
receipts. Errors after that boundary stay conservative UNKNOWN; neither error
text nor a tool's name/replay flag grants known-no-effect status.

## Unknown outcomes and physical work

Every new graph first commits the immutable native `fate.workflow.identity`
document (version 1, session scope: workflowId, parentSessionId, cwd), then gets a
durable active fence. A child admitted without a
confirmed native result receipt permanently fences the graph UNKNOWN. Reopen
inspects/fences before Harness recovery, regardless of a task's replay policy.
Neither an interrupted nor a completed graph identity starts again. Only an
explicit reviewed new workflow creates a new identity.

Native logical cancellation alone is not proof of external SDK/process exit.
Native scopes track their actual host execution promises until settlement and
memoize close. On the production Team path, an aborted `waitForTaskSettlement`
is especially insufficient: a Team may publish `interrupted` while retaining its
SDK turn and checkout lease. For native graphs, AgentWorkflowCoordinator observes
`inspectNode.resources.turnActive`, `leaseHeld`, and `streaming` until those actual
resources have settled, using the existing Team activity subscription. This also
applies before routing a further attempt. The native graph cannot write idle or
close its owned database while these external completions remain pending.

`createOwnedNativeWorkflowSchedulerFactory` takes the same profile owner, data
root, and optional `onUnsafeFailure`, `onCloseUncertain`, `onFailure`, `onReport`.
Unsafe failure callbacks receive NativeExecutionUnknownError or
DurableStorageCloseUncertainError; invalid input and normal pre-effect cancellation
do not disable the host. All cleanup uncertainty is reported before rejection,
including failed open. A failed/unsupported/existence-ambiguous retained database
open is historical UNKNOWN even when backend close succeeds. Storage faults during
new admission also stop automatic retries. A duplicate still-open handle from the
same factory is an explicit known-no-effect refusal. Brand-new file admission is lazy until graph validation
and the caller's pre-admission cancellation check pass, so those known refusals do
not manufacture empty unidentified databases for startup recovery. Existing files
are still inspected eagerly; historical uncertainty is never hidden by laziness. The host must retain its profile owner and close admission
on these unsafe outcomes. A pending close stays pending; a failed close keeps its
failure on every later call.

## Bounds and limitations

The native exported scheduler rejects graphs above 256 nodes; node IDs are bounded
to the existing 80-character workflow grammar, dependencies are unique, and cycles
are rejected before task admission. Effective concurrency is at most the node
count. Existing unconstrained legacy graph input is not silently converted or
truncated. Oversized native requests fail explicitly with no legacy fallback.

This replaces generic DAG scheduling for injected native graphs. It does not yet
replace Agent Team mailbox/turn-capacity policy, GoalMax planning, the routine
occurrence ledger, root SDK AgentSession execution, or native renderer session
projection. Those remain separate responsibilities, not completed milestones.

## Verification

`tests/v2/nativeWorkflowScheduler.test.ts` uses the actual installed Pi Durable
Harness and native task records, with synthetic SDK callbacks. It covers DAG
ordering, first-settled concurrency, dependency policy, UNKNOWN effects/commit
failures, no replay, cancellation, ignored abort/late effects, retained fences,
and bounded/prototype-like graph identities.

`tests/v2/nativeWorkflowEngine.test.ts` composes the actual Fate workflow engine,
AgentWorkflowCoordinator, AgentTeamCoordinator, native Harness and SDK
SessionManager with synthetic child model execution. It verifies original JSONL
identities and dependency context, actual Team leases during ignored abort, and
no native-to-legacy resurrection. No provider credentials or paid model calls.

## Live SDK admission boundary

Host unsafe state fences more than new UI prompts. Actual child SDK sessions have
current synchronous guards on prompt/steer/follow-up/custom-message/compaction and
provider stream dispatch. The upstream beforeToolCall hook is preserved and
chained with checks before and after awaited extension hooks. Root SDK sessions
have the same model/tool-hook boundary and direct auxiliary-model operations
check host shutdown. Fate-owned root ToolDefinitions are guarded in place,
preserving identity for retained handles; controlled filesystem/search/image
tools use a dynamic ProjectToolAccess guard, and image HTTP dispatch checks again
after authentication awaits. Task metadata authority is rechecked after async
preparation and again inside serialized tool-origin mutations immediately before
persistence, while confirmed receipt/evidence publication remains permitted. Team turn dispatch checks the host even for already-queued work or an
injected child factory. Abort and disposal remain available.

These are SDK-routed execution boundaries, not an OS sandbox for arbitrary trusted
extension code executing outside the SDK. They do not replace existing checkout,
permission, process-lifetime or approval policy.

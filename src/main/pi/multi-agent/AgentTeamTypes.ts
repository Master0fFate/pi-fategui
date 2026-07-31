import type { AgentSession, ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ModelInfo, PermissionLevel, ThinkingLevel } from '../../../shared/contracts/ipc';
import type { AgentTeam, AgentTeamEnvelope, AgentTeamNode, AgentTeamTask } from '../../../shared/contracts/multiAgent';
import type { ChildToolName } from '../SubagentProtocol';
import type { SelectedSubagentSkill } from '../SubagentSkills';
import type { TurnLease } from './AgentTeamScheduler';

export interface AgentNodeRuntime {
  session: AgentSession | null;
  sessionFile?: string;
  sessionDirectory: string;
  unsubscribe?: () => void;
  lease?: TurnLease;
  turn?: Promise<void>;
  controlQueue: Promise<void>;
  retentionTimer?: ReturnType<typeof setTimeout>;
  modelRuntime: ModelRuntime;
  profileSystemPrompt: string;
  instructions?: string;
  selectedSkills: SelectedSubagentSkill[];
  skillMode: 'all' | 'selected' | 'none';
}

export interface AgentTeamRuntime {
  state: AgentTeam;
  nodes: Map<string, AgentTeamNode>;
  tasks: Map<string, AgentTeamTask>;
  envelopes: Map<string, AgentTeamEnvelope>;
  nodeRuntime: Map<string, AgentNodeRuntime>;
  pathToNode: Map<string, string>;
  operationReceipts: Map<string, unknown>;
  waitEdges: Map<string, Set<string>>;
  sequence: number;
}

export interface SpawnAgentRequest {
  task: string;
  name?: string;
  role?: string;
  agent?: string;
  permission?: PermissionLevel;
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  tools?: ChildToolName[];
  instructions?: string;
  skills?: string[];
  skillMode?: 'all' | 'selected' | 'none';
  preloadSkills?: boolean;
  contextTurns?: number;
}

export interface PreparedAgentRequest extends SpawnAgentRequest {
  role: string;
  agentName: string;
  permission: PermissionLevel;
  modelInfo: ModelInfo;
  modelValue: NonNullable<AgentSession['model']>;
  thinkingLevel: ThinkingLevel;
  tools: ChildToolName[];
  profileSystemPrompt: string;
  selectedSkills: SelectedSubagentSkill[];
  skillMode: 'all' | 'selected' | 'none';
}

export interface AgentTeamCoordinatorHost {
  resolveRoot(sessionId: string): { projectPath: string; session: AgentSession; permissionLevel: PermissionLevel } | null;
  emit(rootSessionId: string, team: AgentTeam): void;
  persist(rootSessionId: string, event: AgentTeamLedgerEvent): void;
  settled?(rootSessionId: string): void;
}

export type AgentTeamLedgerEvent = {
  kind: 'fate-agent-team-event';
  version: 1;
  teamId: string;
  sequence: number;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
};

export type CollaborationToolFactory = (callerNodeId: string, modelRuntime: ModelRuntime) => ToolDefinition[];

import { agentChannels, agentListInputSchema, agentLibraryResultSchema, agentSaveSchema, agentDefinitionSchema, taskTemplateSaveSchema, taskTemplateSchema, routineSaveSchema, routineDefinitionSchema, libraryItemSchema, agentOpenSchema, agentOpenResultSchema, agentRunInputSchema, agentRunSchema, agentApprovalInputSchema, agentRunIdSchema, agentIdSchema, automationCopyPreviewSchema, automationCopyInputSchema, agentRollbackSchema, agentChangedSchema, agentsLegacyListInputSchema, legacyImportListSchema, type AgentsApi } from '../shared/contracts/agents';
import { invoke, subscribe, ignoreResult } from './transport';

export const agentsApi: AgentsApi = {
  getAgentLibrary: (input = {}) => invoke(agentChannels.agentsList, agentListInputSchema, agentLibraryResultSchema, input),
  saveAgentDefinition: (input) => invoke(agentChannels.agentsSave, agentSaveSchema, agentDefinitionSchema, input),
  saveTaskTemplate: (input) => invoke(agentChannels.agentsSaveTask, taskTemplateSaveSchema, taskTemplateSchema, input),
  saveRoutineDefinition: (input) => invoke(agentChannels.agentsSaveRoutine, routineSaveSchema, routineDefinitionSchema, input),
  deleteAgentLibraryItem: (input) => invoke(agentChannels.agentsDelete, libraryItemSchema, ignoreResult, input),
  openAgentConversation: (input) => invoke(agentChannels.agentsOpen, agentOpenSchema, agentOpenResultSchema, input),
  runAgentTask: (input) => invoke(agentChannels.agentsRun, agentRunInputSchema, agentRunSchema, input),
  decideAgentApproval: (input) => invoke(agentChannels.agentsApprove, agentApprovalInputSchema, ignoreResult, input),
  cancelAgentRun: (input) => invoke(agentChannels.agentsCancel, agentRunIdSchema, ignoreResult, input),
  openAgentRunSession: (input) => invoke(agentChannels.agentsOpenRun, agentRunIdSchema, ignoreResult, input),
  previewAutomationCopy: (input) => invoke(agentChannels.agentsPreviewCopy, agentIdSchema, automationCopyPreviewSchema, input),
  copyAutomationToTask: (input) => invoke(agentChannels.agentsCopy, automationCopyInputSchema, taskTemplateSchema, input),
  rollbackAutomationCopy: (input) => invoke(agentChannels.agentsRollbackCopy, agentRollbackSchema, ignoreResult, input),
  listLegacyAutomations: (input) => invoke(agentChannels.agentsLegacyList, agentsLegacyListInputSchema, legacyImportListSchema, input),
  onAgentLibraryChanged: (listener) => subscribe(agentChannels.agentsChanged, agentChangedSchema, listener, () => undefined),
};

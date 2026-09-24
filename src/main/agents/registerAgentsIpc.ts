import { BrowserWindow } from 'electron';
import {
  agentChannels, agentListInputSchema, agentLibraryResultSchema, agentSaveSchema, agentDefinitionSchema, taskTemplateSaveSchema, taskTemplateSchema,
  routineSaveSchema, routineDefinitionSchema, libraryItemSchema, agentOpenSchema, agentOpenResultSchema, agentRunInputSchema, agentRunSchema,
  agentApprovalInputSchema, agentRunIdSchema, agentIdSchema, automationCopyPreviewSchema, automationCopyInputSchema, agentRollbackSchema, agentChangedSchema,
  agentsLegacyListInputSchema, legacyImportListSchema,
} from '../../shared/contracts/agents';
import type { AgentsService } from './AgentsService';

type Register = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>) => void;
export function registerAgentsIpc(handle: Register, agents?: AgentsService): void {
  const service = () => { if (!agents) throw new Error('Agents service is unavailable.'); return agents; };
  agents?.setChangeSink((change) => {
    const event = agentChangedSchema.parse(change);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(agentChannels.agentsChanged, event);
  });
  handle(agentChannels.agentsList, async (_event, input) => agentLibraryResultSchema.parse(await service().list(agentListInputSchema.parse(input).routineId)));
  handle(agentChannels.agentsSave, async (_event, input) => agentDefinitionSchema.parse(await service().saveAgent(agentSaveSchema.parse(input))));
  handle(agentChannels.agentsSaveTask, async (_event, input) => taskTemplateSchema.parse(await service().saveTask(taskTemplateSaveSchema.parse(input))));
  handle(agentChannels.agentsSaveRoutine, async (_event, input) => routineDefinitionSchema.parse(await service().saveRoutine(routineSaveSchema.parse(input))));
  handle(agentChannels.agentsDelete, async (_event, input) => { await service().remove(libraryItemSchema.parse(input)); });
  handle(agentChannels.agentsOpen, async (_event, input) => {
    const parsed = agentOpenSchema.parse(input);
    return agentOpenResultSchema.parse(await service().open(parsed.agentId, parsed.mode));
  });
  handle(agentChannels.agentsRun, async (_event, input) => agentRunSchema.parse(await service().run(agentRunInputSchema.parse(input))));
  handle(agentChannels.agentsApprove, async (_event, input) => { await service().approve(agentApprovalInputSchema.parse(input)); });
  handle(agentChannels.agentsCancel, async (_event, input) => { await service().cancel(agentRunIdSchema.parse(input).runId); });
  handle(agentChannels.agentsOpenRun, async (_event, input) => { await service().openRun(agentRunIdSchema.parse(input).runId); });
  handle(agentChannels.agentsPreviewCopy, async (_event, input) => automationCopyPreviewSchema.parse(await service().previewCopy(agentIdSchema.parse(input).id)));
  handle(agentChannels.agentsCopy, async (_event, input) => {
    const parsed = automationCopyInputSchema.parse(input);
    return taskTemplateSchema.parse(await service().copyAutomation(parsed.automationId, parsed.sourceDigest));
  });
  handle(agentChannels.agentsRollbackCopy, async (_event, input) => { const parsed = agentRollbackSchema.parse(input); await service().rollbackCopy(parsed.taskId, parsed.expected); });
  handle(agentChannels.agentsLegacyList, async (_event, input) => { agentsLegacyListInputSchema.parse(input); return legacyImportListSchema.parse(await service().listLegacy()); });
}

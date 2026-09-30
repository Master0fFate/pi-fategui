import type { PiDesktopApi } from '../../shared/contracts/ipc';
import { selectFateMethods, type FateApi } from '../../client/FateApi';
import { selectConnectionMethods, type DesktopConnectionApi } from '../../shared/contracts/connections';
import { RemoteDesktopFateApi } from './RemoteDesktopFateApi';

export type DesktopOnlyApi = Omit<PiDesktopApi, keyof FateApi>;

export interface DesktopFateApi extends FateApi {
  readonly desktop: DesktopOnlyApi;
  readonly connections: DesktopConnectionApi;
  readonly remote: RemoteDesktopFateApi;
}

/** Only named native methods cross this boundary. Never expose the input bridge. */
export function selectDesktopMethods(bridge: DesktopOnlyApi): DesktopOnlyApi {
  return {
    ...selectConnectionMethods(bridge),
    acknowledgeTerminal: bridge.acknowledgeTerminal,
    activateBrowserTab: bridge.activateBrowserTab,
    addModelsDevProvider: bridge.addModelsDevProvider,
    answerQuestion: bridge.answerQuestion,
    cancelAgentRun: bridge.cancelAgentRun,
    cancelLearning: bridge.cancelLearning,
    cancelProviderLogin: bridge.cancelProviderLogin,
    cancelSpeechModelDownload: bridge.cancelSpeechModelDownload,
    cancelSpeechStream: bridge.cancelSpeechStream,
    cancelSpeechTranscription: bridge.cancelSpeechTranscription,
    checkForUpdates: bridge.checkForUpdates,
    clearMusicQueue: bridge.clearMusicQueue,
    closeBrowserTab: bridge.closeBrowserTab,
    closeTerminal: bridge.closeTerminal,
    controlBrowserHistory: bridge.controlBrowserHistory,
    controlWindow: bridge.controlWindow,
    copyAutomationToTask: bridge.copyAutomationToTask,
    createBrowserTab: bridge.createBrowserTab,
    createTerminal: bridge.createTerminal,
    decideAgentApproval: bridge.decideAgentApproval,
    deleteAgentLibraryItem: bridge.deleteAgentLibraryItem,
    dismissBrowserAnnotations: bridge.dismissBrowserAnnotations,
    downloadAndInstallUpdate: bridge.downloadAndInstallUpdate,
    downloadSpeechModel: bridge.downloadSpeechModel,
    ensureSpeechModel: bridge.ensureSpeechModel,
    exportSession: bridge.exportSession,
    exportSkinPack: bridge.exportSkinPack,
    feedSpeechStream: bridge.feedSpeechStream,
    focusProject: bridge.focusProject,
    generateLearningDraft: bridge.generateLearningDraft,
    getAgentLibrary: bridge.getAgentLibrary,
    getAppInfo: bridge.getAppInfo,
    getBrowserState: bridge.getBrowserState,
    getDiagnostics: bridge.getDiagnostics,
    getLearningState: bridge.getLearningState,
    getLearningStorage: bridge.getLearningStorage,
    getLogs: bridge.getLogs,
    getMcpServers: bridge.getMcpServers,
    getModelsDevProvider: bridge.getModelsDevProvider,
    getMusicStatus: bridge.getMusicStatus,
    getSettings: bridge.getSettings,
    getSkins: bridge.getSkins,
    getSpeechHotkeyStatus: bridge.getSpeechHotkeyStatus,
    getSpeechStatus: bridge.getSpeechStatus,
    getThemes: bridge.getThemes,
    getWindowState: bridge.getWindowState,
    highlightBrowserAnnotation: bridge.highlightBrowserAnnotation,
    importPiMigration: bridge.importPiMigration,
    importSession: bridge.importSession,
    importSkinPack: bridge.importSkinPack,
    initializeBrowser: bridge.initializeBrowser,
    initializeProviderLogin: bridge.initializeProviderLogin,
    inspectPiMigration: bridge.inspectPiMigration,
    listBrowserAnnotations: bridge.listBrowserAnnotations,
    listLegacyAutomations: bridge.listLegacyAutomations,
    listModelsDevProviders: bridge.listModelsDevProviders,
    loadMusic: bridge.loadMusic,
    logoutProvider: bridge.logoutProvider,
    mutateLearning: bridge.mutateLearning,
    navigateBrowser: bridge.navigateBrowser,
    newWindow: bridge.newWindow,
    onAgentLibraryChanged: bridge.onAgentLibraryChanged,
    onAppCommand: bridge.onAppCommand,
    onBrowserEvents: bridge.onBrowserEvents,
    onBrowserLinkOpen: bridge.onBrowserLinkOpen,
    onLearningChanged: bridge.onLearningChanged,
    onMusicDurations: bridge.onMusicDurations,
    onSpeechDownload: bridge.onSpeechDownload,
    onSpeechStreamUpdate: bridge.onSpeechStreamUpdate,
    onTerminalEvent: bridge.onTerminalEvent,
    onUpdatesProgress: bridge.onUpdatesProgress,
    onVoiceHotkey: bridge.onVoiceHotkey,
    onWindowState: bridge.onWindowState,
    openAgentConversation: bridge.openAgentConversation,
    openAgentRunSession: bridge.openAgentRunSession,
    openBrowserLocalFile: bridge.openBrowserLocalFile,
    openFile: bridge.openFile,
    openProject: bridge.openProject,
    openSkinsFolder: bridge.openSkinsFolder,
    openUpdateDownload: bridge.openUpdateDownload,
    previewAutomationCopy: bridge.previewAutomationCopy,
    previewLearningEvidence: bridge.previewLearningEvidence,
    previewLearningSelection: bridge.previewLearningSelection,
    readLocalImage: bridge.readLocalImage,
    recoverLearning: bridge.recoverLearning,
    removeBrowserAnnotation: bridge.removeBrowserAnnotation,
    removeModelsDevProvider: bridge.removeModelsDevProvider,
    removeSkinPack: bridge.removeSkinPack,
    removeSpeechModel: bridge.removeSpeechModel,
    resizeTerminal: bridge.resizeTerminal,
    resolveMusicTrack: bridge.resolveMusicTrack,
    respondProviderLogin: bridge.respondProviderLogin,
    respondToBrowserConfirmation: bridge.respondToBrowserConfirmation,
    revealFileLink: bridge.revealFileLink,
    revealProject: bridge.revealProject,
    revealProjectPath: bridge.revealProjectPath,
    reviewLearningCapture: bridge.reviewLearningCapture,
    revokeBrowserOriginGrant: bridge.revokeBrowserOriginGrant,
    rollbackAutomationCopy: bridge.rollbackAutomationCopy,
    runAgentTask: bridge.runAgentTask,
    saveAgentDefinition: bridge.saveAgentDefinition,
    saveImageAs: bridge.saveImageAs,
    saveRoutineDefinition: bridge.saveRoutineDefinition,
    saveTaskTemplate: bridge.saveTaskTemplate,
    selectBrowserAnnotation: bridge.selectBrowserAnnotation,
    selectProject: bridge.selectProject,
    selectProjectFile: bridge.selectProjectFile,
    setBrowserBounds: bridge.setBrowserBounds,
    setBrowserControlLevel: bridge.setBrowserControlLevel,
    setBrowserDeviceEmulation: bridge.setBrowserDeviceEmulation,
    setBrowserMode: bridge.setBrowserMode,
    setBrowserOriginGrant: bridge.setBrowserOriginGrant,
    setBrowserOverlayBlocked: bridge.setBrowserOverlayBlocked,
    setBrowserVisible: bridge.setBrowserVisible,
    setMcpServers: bridge.setMcpServers,
    setSettings: bridge.setSettings,
    showBrowserLinkContextMenu: bridge.showBrowserLinkContextMenu,
    snapshotBrowser: bridge.snapshotBrowser,
    startProviderLogin: bridge.startProviderLogin,
    startSpeechStream: bridge.startSpeechStream,
    stopSpeechStream: bridge.stopSpeechStream,
    testMcpServer: bridge.testMcpServer,
    transcribeSpeech: bridge.transcribeSpeech,
    updateBrowserAnnotation: bridge.updateBrowserAnnotation,
    writeClipboardText: bridge.writeClipboardText,
    writeTerminal: bridge.writeTerminal,
  };
}

export function createDesktopFateApi(bridge: PiDesktopApi): DesktopFateApi {
  const connections = selectConnectionMethods(bridge);
  return { ...selectFateMethods(bridge), desktop: selectDesktopMethods(bridge), connections,
    remote: new RemoteDesktopFateApi(connections) };
}

/** Production bootstrap and test-fixture fallback read the bridge here only. */
export function readDesktopBridge(): PiDesktopApi | undefined {
  return typeof window !== 'undefined' ? window.piDesktop : undefined;
}

export function bootstrapDesktopFateApi(): DesktopFateApi {
  const bridge = readDesktopBridge();
  if (!bridge) throw new Error('Desktop preload bridge is unavailable');
  return createDesktopFateApi(bridge);
}

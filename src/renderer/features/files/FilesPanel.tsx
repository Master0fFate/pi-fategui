import { ChevronDown, ChevronRight, ExternalLink, File, FileWarning, Folder, FolderOpen, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { AppTooltip } from '../../components/AppTooltip';
import { HorizontalResizeHandle } from '../../components/HorizontalResizeHandle';
import { selectFileRows, useWorkspaceStore, type FileTreeRow } from '../../stores/workspaceStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { LazyFileViewer } from './LazyMonaco';
import { RasterImagePreview } from './RasterImagePreview';
import { useSkinComponents } from '../../skins/SkinProvider';
import { getWebApiOptional } from '../../platform/api';

function FileRow({ entry, selected, expanded, loading, disabled, onActivate }: {
  entry: FileTreeRow; selected: boolean; expanded: boolean; loading: boolean; disabled: boolean;
  onActivate: (entry: FileTreeRow) => void;
}) {
  const { Symbol } = useSkinComponents();
  const Icon = entry.kind === 'directory' ? (expanded ? FolderOpen : Folder) : File;
  return <AppTooltip content={entry.reference.kind === 'desktop-path' ? entry.reference.path : entry.name}>
    <button type="button" className={`file-row${selected ? ' selected' : ''}`} disabled={disabled}
      aria-expanded={entry.kind === 'directory' ? expanded : undefined}
      style={{ paddingLeft: 9 + entry.depth * 15 }} onClick={() => onActivate(entry)}>
      <Symbol text={entry.kind === 'directory' ? expanded ? '-' : '+' : ' '}>{entry.kind === 'directory'
        ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span className="file-row-spacer" />}</Symbol>
      <Symbol text={loading ? '...' : entry.kind === 'directory' ? '/' : ':'}><Icon size={14} className={loading ? 'file-row-loading' : ''} /></Symbol>
      <span className="icon-label">{entry.name}</span>{entry.symlink && <em className="icon-label">link</em>}
    </button>
  </AppTooltip>;
}

function PreviewState() {
  const { ActionContent } = useSkinComponents();
  const preview = useWorkspaceStore((state) => state.preview);
  const loading = useWorkspaceStore((state) => state.previewLoading);
  const selected = useWorkspaceStore((state) => state.selectedFile);
  const open = useWorkspaceStore((state) => state.openSelectedFile);
  if (loading) return <div className="preview-loading"><span className="preview-spinner" /><span className="icon-label">Reading {selected}…</span></div>;
  if (!preview) return <div className="preview-placeholder"><File size={22} /><span>Select a file to preview</span></div>;
  return <div className="file-preview">
    <div className="preview-heading"><AppTooltip content={preview.path}><span>{preview.path}</span></AppTooltip>
      {preview.state === 'text' && preview.openable && <AppTooltip content="Open in the system editor"><button type="button" aria-label="Open in the system editor" onClick={() => void open()}><ActionContent text="edit"><ExternalLink size={13} aria-hidden="true" /></ActionContent></button></AppTooltip>}
    </div>
    <div className="preview-body">
      {preview.state === 'text' && <LazyFileViewer value={preview.content ?? ''} language={preview.language} path={preview.path} />}
      {preview.state === 'image' && <RasterImagePreview data={preview.content} mimeType={preview.mimeType} path={preview.path} detail={`${preview.mimeType?.slice('image/'.length).toUpperCase() ?? 'Image'} · ${preview.size.toLocaleString()} bytes`} />}
      {preview.state === 'binary' && <div className="preview-placeholder"><FileWarning size={22} /><strong>Binary file</strong><span>{preview.size.toLocaleString()} bytes · Text preview unavailable</span></div>}
      {preview.state === 'large' && <div className="preview-placeholder"><FileWarning size={22} /><strong>Large file</strong><span>{preview.size.toLocaleString()} bytes · Preview is limited to 1 MiB</span></div>}
    </div>
  </div>;
}

export function FilesPanel() {
  const { Symbol } = useSkinComponents();
  const web = getWebApiOptional();
  const scope = useRuntimeStore((state) => state.selected);
  const snapshot = useRuntimeStore((state) => state.snapshot);
  const phase = useRuntimeStore((state) => state.phase);
  const hostFiles = useWorkspaceStore((state) => state.hostFiles);
  const initializeHostFiles = useWorkspaceStore((state) => state.initializeHostFiles);
  const resetHostFiles = useWorkspaceStore((state) => state.resetHostFiles);
  const panelRef = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState(240);
  const resizeTree = (height: number) => {
    const panelHeight = panelRef.current?.clientHeight ?? 0;
    const maximum = Math.max(100, (panelHeight > 0 ? panelHeight : 900) - 180);
    setTreeHeight(Math.min(maximum, Math.max(100, height)));
  };
  const directories = useWorkspaceStore((state) => state.directories);
  const expanded = useWorkspaceStore((state) => state.expanded);
  const loadingDirectories = useWorkspaceStore((state) => state.loadingDirectories);
  const treeTruncated = useWorkspaceStore((state) => state.treeTruncated);
  const query = useWorkspaceStore((state) => state.query);
  const searchResults = useWorkspaceStore((state) => state.searchResults);
  const searchTruncated = useWorkspaceStore((state) => state.searchTruncated);
  const searching = useWorkspaceStore((state) => state.searching);
  const selected = useWorkspaceStore((state) => state.selectedFile);
  const error = useWorkspaceStore((state) => state.error);
  const project = useWorkspaceStore((state) => state.projectPath);
  const setQuery = useWorkspaceStore((state) => state.setQuery);
  const search = useWorkspaceStore((state) => state.search);
  const visible = useMemo(() => selectFileRows(useWorkspaceStore.getState(), web ? 'network' : 'desktop'),
    [directories, expanded, query, searchResults, hostFiles, web]);
  useEffect(() => {
    if (web) return undefined;
    const timer = window.setTimeout(() => { void search(query); }, 220);
    return () => window.clearTimeout(timer);
  }, [query, search, web]);
  useEffect(() => {
    if (!web) return undefined;
    void initializeHostFiles(web);
    return resetHostFiles;
  }, [web, scope, snapshot, phase, initializeHostFiles, resetHostFiles]);
  const activate = (entry: FileTreeRow) => {
    const state = useWorkspaceStore.getState();
    if (entry.reference.kind === 'host-resource') { if (web) void state.activateHostFile(web, entry); }
    else if (entry.kind === 'directory') void state.toggleDirectory(entry.reference.path);
    else void state.selectFile(entry.reference.path);
  };
  if (web && !web.supports('file.read')) return <p className="inspector-empty">Host file reading is unavailable.</p>;
  if (web && (!scope || !snapshot || phase !== 'observing')) return <p className="inspector-empty" role="status">Host files are not current. Refresh a selected workspace; host work may continue.</p>;
  if (!web && !project) return <div className="inspector-empty"><Folder size={24} /><strong>No project files</strong><p>Open a project to browse its file tree.</p></div>;
  const shownError = web ? hostFiles.error : error;
  return <div ref={panelRef} className="files-panel" aria-label={web ? 'Host files' : undefined}>
    {web ? <p className="bounded-note">Host-scoped resources only. File search and native opening are unavailable.</p>
      : <label className="file-search"><Symbol text="/"><Search size={13} /></Symbol><input className="icon-label" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search project files" aria-label="Search project files" />{searching && <span className="preview-spinner" />}</label>}
    {shownError && <div className="workspace-error" role="alert">{shownError}</div>}
    <div className="file-tree" aria-label="Project file tree" style={{ flexBasis: treeHeight }}>
      {visible.length > 0 ? <Virtuoso data={visible} computeItemKey={(_index, entry) => entry.id}
        itemContent={(_index, entry) => <FileRow entry={entry} selected={(web ? hostFiles.selected : selected) === entry.id}
          expanded={(web ? hostFiles.expanded : expanded).has(entry.id)} loading={(web ? hostFiles.loading : loadingDirectories).has(entry.id)}
          disabled={Boolean(web && (phase !== 'observing' || !web.isConnected))} onActivate={activate} />} />
        : <div className="mini-empty">{web ? hostFiles.loading.size ? 'Reading host files…' : hostFiles.error ? 'Files unavailable' : 'No entries returned'
          : searching ? 'Searching…' : query ? 'No matching files' : 'This project is empty'}</div>}
      {web && Object.values(hostFiles.directories).some((listing) => listing.truncated) && <div className="bounded-note">A directory is partial; only 200 entries were returned.</div>}
      {!web && searchTruncated && <div className="bounded-note">Search is incomplete because a result or directory limit was reached</div>}
      {!web && !query.trim() && treeTruncated.size > 0 && <div className="bounded-note">Some directories contain more than 2,000 entries and are shown partially</div>}
    </div>
    <HorizontalResizeHandle label="Resize file tree and preview" value={treeHeight} minimum={100} maximum={720} onChange={resizeTree} onReset={() => resizeTree(240)} />
    {web ? <div className="file-preview"><div className="preview-heading">Text preview · host file</div>
      <pre className="preview-body">{hostFiles.previewLoading ? 'Reading host file…' : hostFiles.preview
        ? hostFiles.preview.content + (hostFiles.preview.truncated ? '\n… Text preview truncated by the host.' : '') : 'Select a supported text file to read it.'}</pre></div> : <PreviewState />}
  </div>;
}

import { ChevronDown, ChevronRight, ExternalLink, File, FileWarning, Folder, FolderOpen, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { FileEntry } from '../../../shared/contracts/ipc';
import { AppTooltip } from '../../components/AppTooltip';
import { HorizontalResizeHandle } from '../../components/HorizontalResizeHandle';
import { flattenTree, useWorkspaceStore, type VisibleFileEntry } from '../../stores/workspaceStore';
import { LazyFileViewer } from './LazyMonaco';
import { RasterImagePreview } from './RasterImagePreview';

function FileRow({ entry, selected, expanded, loading, onActivate }: {
  entry: VisibleFileEntry;
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  onActivate: (entry: FileEntry) => void;
}) {
  const Icon = entry.kind === 'directory' ? (expanded ? FolderOpen : Folder) : File;
  return (
    <AppTooltip content={entry.path}>
      <button
        type="button"
        className={`file-row${selected ? ' selected' : ''}`}
        style={{ paddingLeft: 9 + entry.depth * 15 }}
        onClick={() => onActivate(entry)}
      >
        {entry.kind === 'directory' ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span className="file-row-spacer" />}
        <Icon size={14} className={loading ? 'file-row-loading' : ''} />
        <span className="icon-label">{entry.name}</span>
        {entry.symlink && <em className="icon-label">link</em>}
      </button>
    </AppTooltip>
  );
}

function PreviewState() {
  const preview = useWorkspaceStore((state) => state.preview);
  const loading = useWorkspaceStore((state) => state.previewLoading);
  const selected = useWorkspaceStore((state) => state.selectedFile);
  const open = useWorkspaceStore((state) => state.openSelectedFile);
  if (loading) return <div className="preview-loading"><span className="preview-spinner" /><span className="icon-label">Reading {selected}…</span></div>;
  if (!preview) return <div className="preview-placeholder"><File size={22} /><span>Select a file to preview</span></div>;
  return (
    <div className="file-preview">
      <div className="preview-heading">
        <AppTooltip content={preview.path}><span>{preview.path}</span></AppTooltip>
        {preview.state === 'text' && preview.openable && <AppTooltip content="Open in the system editor"><button type="button" aria-label="Open in the system editor" onClick={() => void open()}><ExternalLink size={13} aria-hidden="true" /></button></AppTooltip>}
      </div>
      <div className="preview-body">
        {preview.state === 'text' && <LazyFileViewer value={preview.content ?? ''} language={preview.language} path={preview.path} />}
        {preview.state === 'image' && <RasterImagePreview data={preview.content} mimeType={preview.mimeType} path={preview.path} detail={`${preview.mimeType?.slice('image/'.length).toUpperCase() ?? 'Image'} · ${preview.size.toLocaleString()} bytes`} />}
        {preview.state === 'binary' && <div className="preview-placeholder"><FileWarning size={22} /><strong>Binary file</strong><span>{preview.size.toLocaleString()} bytes · Text preview unavailable</span></div>}
        {preview.state === 'large' && <div className="preview-placeholder"><FileWarning size={22} /><strong>Large file</strong><span>{preview.size.toLocaleString()} bytes · Preview is limited to 1 MiB</span></div>}
      </div>
    </div>
  );
}

export function FilesPanel() {
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
  const toggle = useWorkspaceStore((state) => state.toggleDirectory);
  const select = useWorkspaceStore((state) => state.selectFile);
  const tree = useMemo(() => flattenTree(directories, expanded), [directories, expanded]);
  const visible: VisibleFileEntry[] = query.trim()
    ? searchResults.map((entry) => ({ ...entry, depth: Math.max(0, entry.path.split('/').length - 1) }))
    : tree;

  useEffect(() => {
    const timer = window.setTimeout(() => { void search(query); }, 220);
    return () => window.clearTimeout(timer);
  }, [query, search]);

  const activate = (entry: FileEntry) => {
    if (entry.kind === 'directory') void toggle(entry.path);
    else void select(entry.path);
  };

  if (!project) return <div className="inspector-empty"><Folder size={24} /><strong>No project files</strong><p>Open a project to browse its file tree.</p></div>;
  return (
    <div ref={panelRef} className="files-panel">
      <label className="file-search"><Search size={13} /><input className="icon-label" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search project files" aria-label="Search project files" />{searching && <span className="preview-spinner" />}</label>
      {error && <div className="workspace-error" role="alert">{error}</div>}
      <div className="file-tree" aria-label="Project file tree" style={{ flexBasis: treeHeight }}>
        {visible.length > 0 ? (
          <Virtuoso
            data={visible}
            computeItemKey={(_index, entry) => entry.path}
            itemContent={(_index, entry) => <FileRow entry={entry} selected={selected === entry.path} expanded={expanded.has(entry.path)} loading={loadingDirectories.has(entry.path)} onActivate={activate} />}
          />
        ) : <div className="mini-empty">{searching ? 'Searching…' : query ? 'No matching files' : 'This project is empty'}</div>}
        {searchTruncated && <div className="bounded-note">Search is incomplete because a result or directory limit was reached</div>}
        {!query.trim() && treeTruncated.size > 0 && <div className="bounded-note">Some directories contain more than 2,000 entries and are shown partially</div>}
      </div>
      <HorizontalResizeHandle label="Resize file tree and preview" value={treeHeight} minimum={100} maximum={720} onChange={resizeTree} onReset={() => resizeTree(240)} />
      <PreviewState />
    </div>
  );
}

import * as Popover from '@radix-ui/react-popover';
import {
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  EyeOff,
  FileDiff,
  FileMinus2,
  FilePenLine,
  FilePlus2,
  FileWarning,
  Files,
  GitBranch,
  GitCommit,
  GitGraph,
  Github,
  LoaderCircle,
  RefreshCw,
  UserRound,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { GitChange, GitCommitDetails, GitCommitSummary } from '../../../shared/contracts/ipc';
import { AppTooltip } from '../../components/AppTooltip';
import { writeClipboardText } from '../../lib/clipboard';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { LazyDiffViewer, LazyFileViewer } from '../files/LazyMonaco';
import { RasterImagePreview } from '../files/RasterImagePreview';

const GRAPH_LANE_LIMIT = 8;

type ChangesView = 'diff' | 'branch';

interface CommitGraphRow {
  commit: GitCommitSummary;
  lane: number;
  before: string[];
  after: string[];
}

function displayError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  try {
    const parsed = JSON.parse(error.message) as { message?: string };
    return parsed.message ?? error.message;
  } catch { return error.message; }
}

function changeStatus(change: GitChange) {
  const status = change.workTreeStatus !== ' ' ? change.workTreeStatus : change.indexStatus;
  if (status === 'M') return { label: 'Modified', className: 'modified', Icon: FilePenLine };
  if (status === 'A' || status === '?') return { label: 'Added', className: 'added', Icon: FilePlus2 };
  if (status === 'D') return { label: 'Deleted', className: 'deleted', Icon: FileMinus2 };
  if (status === 'R' || status === 'C') return { label: status === 'R' ? 'Renamed' : 'Copied', className: 'moved', Icon: Files };
  if (status === '!') return { label: 'Ignored', className: 'ignored', Icon: EyeOff };
  return { label: 'Unmerged', className: 'unmerged', Icon: CircleAlert };
}

export function buildCommitGraphRows(commits: readonly GitCommitSummary[]): CommitGraphRow[] {
  const lanes: string[] = [];
  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) {
      lane = 0;
      lanes.unshift(commit.hash);
    }
    const before = lanes.slice(0, GRAPH_LANE_LIMIT);
    const firstParent = commit.parents[0];
    if (firstParent) lanes[lane] = firstParent;
    else lanes.splice(lane, 1);
    for (let index = commit.parents.length - 1; index >= 1; index -= 1) {
      const parent = commit.parents[index]!;
      if (!lanes.includes(parent)) lanes.splice(lane + 1, 0, parent);
    }
    for (let index = lanes.length - 1; index >= 0; index -= 1) {
      if (lanes.indexOf(lanes[index]!) !== index) lanes.splice(index, 1);
    }
    return { commit, lane: Math.min(lane, GRAPH_LANE_LIMIT - 1), before, after: lanes.slice(0, GRAPH_LANE_LIMIT) };
  });
}

function relativeCommitTime(value: string): string {
  const difference = new Date(value).getTime() - Date.now();
  const absolute = Math.abs(difference);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (absolute < 60_000) return formatter.format(Math.round(difference / 1_000), 'second');
  if (absolute < 3_600_000) return formatter.format(Math.round(difference / 60_000), 'minute');
  if (absolute < 86_400_000) return formatter.format(Math.round(difference / 3_600_000), 'hour');
  return formatter.format(Math.round(difference / 86_400_000), 'day');
}

function CommitGraphRail({ row }: { row: CommitGraphRow }) {
  const laneCount = Math.max(row.before.length, row.after.length, row.lane + 1, 1);
  const width = laneCount * 11 + 9;
  const nodeX = row.lane * 11 + 7;
  return (
    <svg className="commit-graph-rail" width={width} viewBox={`0 0 ${width} 32`} preserveAspectRatio="none" aria-hidden="true">
      {row.before.map((hash, index) => {
        const continues = row.after.includes(hash) || hash === row.commit.hash;
        return continues ? <line key={`before-${hash}-${index}`} className={`graph-lane graph-lane--${index % 5}`} x1={index * 11 + 7} y1="0" x2={index * 11 + 7} y2="16" /> : null;
      })}
      {row.after.map((hash, index) => {
        const parentIndex = index;
        const isParent = row.commit.parents.includes(hash);
        return isParent
          ? <line key={`after-${hash}-${index}`} className={`graph-lane graph-lane--${parentIndex % 5}`} x1={nodeX} y1="16" x2={index * 11 + 7} y2="32" />
          : <line key={`after-${hash}-${index}`} className={`graph-lane graph-lane--${parentIndex % 5}`} x1={index * 11 + 7} y1="16" x2={index * 11 + 7} y2="32" />;
      })}
      <circle className={`graph-node graph-node--${row.lane % 5}`} cx={nodeX} cy="16" r="3.5" />
    </svg>
  );
}

function MetricTooltip({ label, children }: { label: string; children: React.ReactElement }) {
  return <AppTooltip content={label} sideOffset={7}>{children}</AppTooltip>;
}

export function ChangeRow({ change, selected, disabled = false, onSelect }: { change: GitChange; selected: boolean; disabled?: boolean; onSelect: () => void }) {
  const status = changeStatus(change);
  return (
    <button className={`change-row${selected ? ' selected' : ''}`} type="button" onClick={onSelect} disabled={disabled}>
      <AppTooltip content={status.label}><span className={`change-kind change-kind--${status.className}`} aria-label={`${status.label} file`}><status.Icon size={13} aria-hidden="true" /></span></AppTooltip>
      <AppTooltip content={change.path}><span className="change-path icon-label">{change.oldPath && <small>{change.oldPath} → </small>}{change.path}</span></AppTooltip>
    </button>
  );
}

function CommitCard({ commit, details, loading }: { commit: GitCommitSummary; details?: GitCommitDetails; loading: boolean }) {
  const [copied, setCopied] = useState(false);
  const copyHash = async () => {
    try {
      await writeClipboardText(commit.hash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    } catch { setCopied(false); }
  };
  const exactTime = new Date(commit.authoredAt).toLocaleString();
  return (
    <div className="commit-card" aria-label={`Commit details for ${commit.subject}`}>
      <div className="commit-card-author">
        <span className="commit-avatar"><UserRound size={13} aria-hidden="true" /></span>
        <strong className="icon-label">{commit.authorName}</strong>
        <AppTooltip content={exactTime}><span className="icon-label">{relativeCommitTime(commit.authoredAt)} · {exactTime}</span></AppTooltip>
      </div>
      <p>{commit.subject || 'Commit without a subject'}</p>
      {loading && !details ? <div className="commit-card-loading"><LoaderCircle className="tool-spinner" size={13} /><span className="icon-label">Loading commit statistics…</span></div> : details && (
        <div className="commit-card-stats">
          <span>{details.filesChanged} file{details.filesChanged === 1 ? '' : 's'} changed</span>
          <b>{details.additions} insertion{details.additions === 1 ? '' : 's'}(+)</b>
          <i>{details.deletions} deletion{details.deletions === 1 ? '' : 's'}(-)</i>
        </div>
      )}
      {(details?.refs ?? commit.refs).length > 0 && <div className="commit-ref-list">{(details?.refs ?? commit.refs).map((ref) => <span key={`${ref.kind}:${ref.name}`} data-kind={ref.kind}>{ref.name}</span>)}</div>}
      <div className="commit-card-actions">
        <button type="button" aria-label={`Copy commit hash ${commit.hash.slice(0, 12)}`} onClick={() => void copyHash()}>{copied ? <Check size={12} /> : <Copy size={12} />}<span className="icon-label">{commit.hash.slice(0, 12)}</span></button>
        {details?.githubUrl ? <button type="button" onClick={() => window.open(details.githubUrl!, '_blank', 'noopener,noreferrer')}><Github size={13} /><span className="icon-label">Open on GitHub</span></button> : <span className="commit-card-no-remote">No GitHub remote</span>}
      </div>
    </div>
  );
}

function CommitRow({ row }: { row: CommitGraphRow }) {
  const details = useWorkspaceStore((state) => state.commitDetails[row.commit.hash]);
  const loading = useWorkspaceStore((state) => state.commitDetailsLoading.has(row.commit.hash));
  const selected = useWorkspaceStore((state) => state.selectedCommit === row.commit.hash);
  const loadDetails = useWorkspaceStore((state) => state.loadCommitDetails);
  const selectCommit = useWorkspaceStore((state) => state.selectCommit);
  const [cardOpen, setCardOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); }, []);
  const openCard = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setCardOpen(true);
    void loadDetails(row.commit.hash);
  };
  const scheduleClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setCardOpen(false), 110);
  };
  return (
    <div className={`commit-row${selected ? ' selected' : ''}`}>
      <CommitGraphRail row={row} />
      <Popover.Root open={cardOpen} onOpenChange={setCardOpen}>
        <Popover.Anchor asChild>
          <button
            className="commit-row-main"
            type="button"
            aria-expanded={selected}
            onPointerEnter={openCard}
            onPointerLeave={scheduleClose}
            onFocus={openCard}
            onBlur={scheduleClose}
            onClick={() => { selectCommit(selected ? null : row.commit.hash); void loadDetails(row.commit.hash); }}
          >
            <span className="commit-subject">{row.commit.subject || 'Commit without a subject'}</span>
            <span className="commit-author">{row.commit.authorName}</span>
            {row.commit.refs.slice(0, 2).map((ref) => <span className="commit-row-ref" data-kind={ref.kind} key={`${ref.kind}:${ref.name}`}>{ref.name}</span>)}
          </button>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content className="commit-card-popover" side="right" align="start" sideOffset={10} collisionPadding={12} onPointerEnter={openCard} onPointerLeave={scheduleClose} onFocusCapture={openCard} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose(); }}>
            <CommitCard commit={row.commit} {...(details ? { details } : {})} loading={loading} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {selected && details && (
        <div className="commit-file-tree" aria-label={`Files changed in ${row.commit.subject}`}>
          {details.files.map((file) => (
            <AppTooltip key={`${file.oldPath ?? ''}:${file.path}`} content={file.path}>
              <div><span>{file.status[0]}</span><span>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span></div>
            </AppTooltip>
          ))}
          {details.filesTruncated && <small>File tree limited to 500 entries</small>}
        </div>
      )}
    </div>
  );
}

function DiffPreview() {
  const diff = useWorkspaceStore((state) => state.diff);
  const loading = useWorkspaceStore((state) => state.diffLoading);
  const combined = useWorkspaceStore((state) => state.combinedDiff);
  const combinedLoading = useWorkspaceStore((state) => state.combinedDiffLoading);
  const selected = useWorkspaceStore((state) => state.selectedChange);
  const openPath = useWorkspaceStore((state) => state.openPath);
  const git = useWorkspaceStore((state) => state.git);
  const selectedStatus = git?.changes.find((change) => change.path === selected);
  const deleted = selectedStatus?.indexStatus === 'D' || selectedStatus?.workTreeStatus === 'D';
  if (combinedLoading) return <div className="preview-loading"><span className="preview-spinner" /><span className="icon-label">Building combined working-tree diff…</span></div>;
  if (combined) return (
    <div className="file-preview">
      <div className="preview-heading"><AppTooltip content="Combined working-tree diff"><span>Working tree diff{combined.truncated ? ' · truncated' : ''}</span></AppTooltip></div>
      <div className="preview-body"><LazyFileViewer value={combined.patch || 'Working tree clean'} language="diff" path="working-tree.diff" /></div>
    </div>
  );
  if (loading) return <div className="preview-loading"><span className="preview-spinner" /><span className="icon-label">Building bounded diff…</span></div>;
  if (!diff) return <div className="preview-placeholder"><FileDiff size={22} /><span>Select a changed file or a header metric to inspect</span></div>;
  return (
    <div className="file-preview">
      <div className="preview-heading">
        <AppTooltip content={diff.path}><span>{diff.path}</span></AppTooltip>
        {!deleted && diff.state === 'text' && diff.openable && <AppTooltip content="Open in the system editor"><button type="button" onClick={() => void openPath(diff.path)}><ExternalLink size={13} /><span className="icon-label">Open</span></button></AppTooltip>}
      </div>
      <div className="preview-body">
        {diff.state === 'text' && <LazyDiffViewer original={diff.original ?? ''} modified={diff.modified ?? ''} language={diff.language} path={diff.path} />}
        {diff.state === 'image' && <RasterImagePreview data={diff.imageData} mimeType={diff.mimeType} path={diff.path} detail={diff.message} />}
        {diff.state !== 'text' && diff.state !== 'image' && <div className="preview-placeholder"><FileWarning size={22} /><strong>{diff.state === 'binary' ? 'Binary change' : diff.state === 'large' ? 'Diff too large' : 'Diff unavailable'}</strong><span>{diff.message ?? 'This change cannot be displayed.'}</span></div>}
      </div>
    </div>
  );
}

export function ChangesPanel() {
  const project = useWorkspaceStore((state) => state.projectPath);
  const git = useWorkspaceStore((state) => state.git);
  const loading = useWorkspaceStore((state) => state.gitLoading);
  const worktrees = useWorkspaceStore((state) => state.worktrees);
  const worktreesLoading = useWorkspaceStore((state) => state.worktreesLoading);
  const history = useWorkspaceStore((state) => state.history);
  const historyLoading = useWorkspaceStore((state) => state.historyLoading);
  const selected = useWorkspaceStore((state) => state.selectedChange);
  const diffLoading = useWorkspaceStore((state) => state.diffLoading);
  const error = useWorkspaceStore((state) => state.error);
  const refresh = useWorkspaceStore((state) => state.refreshGit);
  const loadWorktrees = useWorkspaceStore((state) => state.loadWorktrees);
  const loadHistory = useWorkspaceStore((state) => state.loadHistory);
  const loadCombinedDiff = useWorkspaceStore((state) => state.loadCombinedDiff);
  const select = useWorkspaceStore((state) => state.selectChange);
  const runtime = useRuntimeStore((state) => state.runtime);
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const showToast = useUiStore((state) => state.showToast);
  const [view, setView] = useState<ChangesView>('diff');
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const graph = useMemo(() => buildCommitGraphRows(history?.commits ?? []), [history?.commits]);

  const switchView = (next: ChangesView) => {
    setView(next);
    if (next === 'branch') void loadHistory();
  };
  const refreshAll = async () => {
    try {
      await refresh();
        if (view === 'branch') await loadHistory(true);
        const updated = useWorkspaceStore.getState().git;
        showToast({
          kind: 'success',
          title: 'Git status refreshed',
          message: updated?.branch === ''
          ? 'Detached HEAD status is current.'
          : updated?.upstream
            ? `${updated.branch} tracks ${updated.upstream}${updated.ahead || updated.behind ? ` · ${updated.ahead} ahead, ${updated.behind} behind` : ' · up to date'}`
            : updated?.branch ? `${updated.branch} status is current.` : 'Repository status is current.',
        });
      } catch (caught) {
        showToast({ kind: 'error', title: 'Git refresh failed', message: displayError(caught, 'Git status could not be refreshed.') });
      }
  };
  const switchWorktree = async (path: string) => {
    if (!('piDesktop' in window) || worktreeBusy) return;
    setWorktreeBusy(true);
    try {
      const previousProject = runtime.project?.path;
      const nextRuntime = await window.piDesktop.switchGitWorktree(path);
      setRuntime(nextRuntime);
      if (nextRuntime.project?.path === previousProject) {
        showToast({ kind: 'info', title: 'Worktree unchanged', message: 'The worktree change was cancelled.' });
      } else {
        showToast({ kind: 'success', title: 'Worktree changed', message: 'Pi, files, terminal, sessions, and Git now share the selected worktree.' });
      }
    } catch (caught) {
      showToast({ kind: 'error', title: 'Worktree change failed', message: displayError(caught, 'The worktree could not be opened.') });
    } finally { setWorktreeBusy(false); }
  };
  if (!project) return <div className="inspector-empty"><FileDiff size={24} /><strong>No changes</strong><p>Open a project to inspect Git changes.</p></div>;
  if (loading && !git) return <div className="preview-loading"><span className="preview-spinner" /><span className="icon-label">Reading Git status…</span></div>;
  if (git && !git.repository) return <div className="inspector-empty"><GitBranch size={24} /><strong>Not a Git repository</strong><p>File browsing is available, but there is no Git status for this project.</p></div>;
  const changes = git?.changes ?? [];
  const detached = git?.branch === '';
  const branch = detached ? 'HEAD' : git?.branch ?? 'HEAD';
  const controlsBusy = loading || worktreeBusy;
  const nextView = view === 'diff' ? 'branch' : 'diff';
  const viewLabel = view === 'diff' ? 'Diff' : 'Branch';
  const nextViewLabel = nextView === 'diff' ? 'working-tree diff' : 'branch history';
  const ViewIcon = view === 'diff' ? FileDiff : GitGraph;
  return (
      <div className="changes-panel" data-view={view}>
        <div className="changes-summary">
          <Popover.Root onOpenChange={(open) => { if (open) void loadWorktrees(); }}>
            <Popover.Trigger asChild>
              <button className="changes-branch" type="button" aria-label={`Change worktree. Current branch: ${branch}`} disabled={controlsBusy}><GitBranch size={13} aria-hidden="true" /><span className="icon-label">{branch}</span></button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content className="worktree-popover" side="bottom" align="start" sideOffset={7} collisionPadding={12}>
                <div className="worktree-popover-heading"><strong>Worktrees</strong><span>Changing worktrees reopens Pi at that project root.</span></div>
                {worktreesLoading ? <div className="worktree-loading"><LoaderCircle className="tool-spinner" size={13} /><span className="icon-label">Reading worktrees…</span></div> : worktrees.map((worktree) => (
                  <Popover.Close asChild key={worktree.path}>
                    <button type="button" data-active={worktree.current} disabled={worktree.current || worktreeBusy || runtime.streaming || Boolean(runtime.sessionOperation)} onClick={() => void switchWorktree(worktree.path)}>
                      <GitBranch size={13} /><span><strong>{worktree.branch ?? 'Detached HEAD'}</strong><small>{worktree.path}</small></span>{worktree.current && <Check size={12} />}
                    </button>
                  </Popover.Close>
                ))}
                {!worktreesLoading && worktrees.length === 0 && <div className="worktree-loading">No registered worktrees</div>}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <span className="summary-counts">
            <AppTooltip content={`Switch to ${nextViewLabel}`}>
              <button className="git-view-toggle" type="button" aria-label={`Switch to ${nextViewLabel}`} onClick={() => switchView(nextView)}><ViewIcon size={12} /><span className="icon-label">{viewLabel}</span></button>
            </AppTooltip>
            <MetricTooltip label={`${changes.length} changed file${changes.length === 1 ? '' : 's'}`}><button className="summary-metric summary-metric--files" type="button" aria-label={`${changes.length} changed files. Open combined diff`} onClick={() => void loadCombinedDiff()}><Files size={12} /><strong className="icon-label">{changes.length}</strong></button></MetricTooltip>
            <MetricTooltip label={`${git?.additions ?? 0} lines added`}><button className="summary-metric summary-metric--added" type="button" aria-label={`${git?.additions ?? 0} lines added. Open combined diff`} onClick={() => void loadCombinedDiff()}>+{git?.additions ?? 0}</button></MetricTooltip>
            <MetricTooltip label={`${git?.deletions ?? 0} lines removed`}><button className="summary-metric summary-metric--removed" type="button" aria-label={`${git?.deletions ?? 0} lines removed. Open combined diff`} onClick={() => void loadCombinedDiff()}>−{git?.deletions ?? 0}</button></MetricTooltip>
          </span>
          <MetricTooltip label={detached ? 'Refresh detached HEAD status' : 'Refresh Git status'}><button className="git-refresh-button" type="button" aria-label={detached ? 'Refresh detached HEAD status' : 'Refresh Git status'} disabled={controlsBusy} onClick={() => void refreshAll()}><RefreshCw className={loading ? 'tool-spinner' : ''} size={13} /></button></MetricTooltip>
        </div>
        {error && <div className="workspace-error" role="alert">{error}</div>}
        {view === 'diff' ? (
          changes.length > 0 ? (
            <div className="changes-list" aria-label="Changed files">
              <Virtuoso data={changes} initialItemCount={Math.min(changes.length, 24)} computeItemKey={(_index, change) => change.path} itemContent={(_index, change) => <ChangeRow change={change} selected={selected === change.path} disabled={diffLoading} onSelect={() => void select(change.path)} />} />
              {git?.truncated && <div className="bounded-note">Change list limited to 10,000 files</div>}
            </div>
          ) : <div className="mini-empty">Working tree clean</div>
        ) : (
          <div className="changes-list commit-graph-list" aria-label="Branch history">
            {historyLoading && !history ? <div className="preview-loading"><span className="preview-spinner" /><span className="icon-label">Loading commit graph…</span></div> : graph.length > 0 ? (
              <Virtuoso data={graph} initialItemCount={Math.min(graph.length, 24)} computeItemKey={(_index, row) => row.commit.hash} itemContent={(_index, row) => <CommitRow row={row} />} />
            ) : <div className="mini-empty"><GitCommit size={16} />No commits yet</div>}
            {history?.truncated && <div className="bounded-note">History limited to 500 commits</div>}
          </div>
        )}
        <DiffPreview />
      </div>
  );
}

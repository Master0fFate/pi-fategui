import { lazy, Suspense } from 'react';

const FileViewer = lazy(() => import('./MonacoViewer').then((module) => ({ default: module.FileMonacoViewer })));
const DiffViewer = lazy(() => import('./MonacoViewer').then((module) => ({ default: module.DiffMonacoViewer })));

function Fallback() {
  return <div className="preview-loading"><span className="preview-spinner" />Loading editor…</div>;
}

export function LazyFileViewer(props: { value: string; language: string; path: string }) {
  return <Suspense fallback={<Fallback />}><FileViewer {...props} /></Suspense>;
}

export function LazyDiffViewer(props: { original: string; modified: string; language: string; path: string }) {
  return <Suspense fallback={<Fallback />}><DiffViewer {...props} /></Suspense>;
}

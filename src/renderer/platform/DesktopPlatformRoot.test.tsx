import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
// Renderer state tests only. App/API stubs do not prove native/SSH acceptance.
const fixture = vi.hoisted(() => ({
  state: { kind: 'local', generation: 1 },
  list: vi.fn(async () => []),
  initialize: vi.fn(async () => undefined),
  select: vi.fn(),
  pick: vi.fn(async () => null),
  save: vi.fn(),
}));
// The workbench fixture mounts the real Settings page for hosts: the only place with host controls.
vi.mock('../app/App', async () => {
  const { HostSettings } = await import('../features/connections/HostSettings');
  return { App: () => <div className="app-shell" data-testid="fixture-workbench"><HostSettings /></div> };
});
vi.mock('./api', () => ({
  subscribeDesktopConnection: () => () => undefined,
  getDesktopConnectionRevision: () => 1,
  getDesktopConnectionState: () => fixture.state,
  getDesktopConnectionsOptional: () => ({ listConnectionProfiles: fixture.list, selectConnectionProfile: fixture.select,
    pickConnectionCredential: fixture.pick, saveSshConnectionProfile: fixture.save }),
  getFateApiOptional: () => null,
  initializeDesktopConnections: fixture.initialize,
}));
import { DesktopPlatformRoot } from './DesktopPlatformRoot';
beforeEach(() => {
  fixture.list.mockReset().mockResolvedValue([]); fixture.initialize.mockReset().mockResolvedValue(undefined);
  fixture.select.mockReset(); fixture.pick.mockClear(); fixture.save.mockClear();
});
it('discloses list initialization failure for a local target even with no loaded profiles', async () => {
  fixture.list.mockRejectedValueOnce(new Error('private backend detail must not be displayed'));
  render(<DesktopPlatformRoot />); await screen.findByTestId('fixture-workbench');
  expect(screen.getByRole('alert')).toHaveTextContent('saved execution host is unavailable');
  expect(document.body.textContent).not.toContain('private backend detail');
  expect(fixture.state.kind).toBe('local'); expect(fixture.select).not.toHaveBeenCalled();
  expect(fixture.pick).not.toHaveBeenCalled(); expect(fixture.save).not.toHaveBeenCalled();
});
it('keeps a genuinely empty local host page without an error, a selector or a target change', async () => {
  render(<DesktopPlatformRoot />); await screen.findByTestId('fixture-workbench');
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByRole('combobox', { name: 'Execution host' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Add SSH host' })).toBeInTheDocument();
  expect(fixture.select).not.toHaveBeenCalled(); expect(fixture.pick).not.toHaveBeenCalled(); expect(fixture.save).not.toHaveBeenCalled();
});
it('draws nothing above the workbench, so the first row of the window is the title bar', async () => {
  const { container } = render(<DesktopPlatformRoot />);
  const workbench = await screen.findByTestId('fixture-workbench');
  expect(container.querySelector('.desktop-platform-root')!.firstElementChild).toBe(workbench);
  expect(container.querySelector('.desktop-host-selector')).toBeNull();
});
it('offers the saved hosts in Settings and selects one only on an explicit choice', async () => {
  fixture.list.mockResolvedValue([{ id: '30000000-0000-4000-8000-000000000001', label: 'Build box', hostId: '30000000-0000-4000-8000-000000000002' }] as never);
  render(<DesktopPlatformRoot />); await screen.findByTestId('fixture-workbench');
  expect(await screen.findByRole('combobox', { name: 'Execution host' })).toHaveTextContent('This computer');
  expect(screen.getByRole('tabpanel')).toHaveTextContent('Build box');
  expect(fixture.select).not.toHaveBeenCalled();
});

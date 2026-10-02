# Fixed-viewport scroll compatibility

Fate's desktop and browser entries both import `src/renderer/styles/global.css`. Its `html, body, #root` rule sets width and height to 100%, margin to zero, and overflow to hidden. Scrolling belongs to inner workspace, settings, dialog, list and inspector panes. There is no page/body scrollbar to remove or compensate while opening a modal.

## Narrow dependency adaptation

The exact `react-remove-scroll@2.7.2` patch removes only its import/render of the body-scrollbar component and its import of two public class-name constants. It retains those public strings. The published wheel/touch handlers, nested lock stack, content-shard handling, pinch-zoom option, inert behavior, event listener cleanup, forwarding and refs are unchanged. ES5, ES2015 and ES2019 entry variants are patched consistently.

The workspace override `react-remove-scroll@2.7.2>react-remove-scroll-bar: '-'` removes that unused dependency from resolution. It does not substitute another package's license, invent terms, or relax the browser notice writer. `react-remove-scroll@2.7.2` has its own complete published MIT license, which is preserved. The former `react-remove-scroll-bar@2.3.8` attribution question remains unresolved for any older artifact that includes it.

This is an application-specific fixed-viewport adaptation, not a general replacement for body-scrollbar management. If either entry becomes a scrolling document, this patch must be replaced or redesigned first. Do not reuse the patched package in an independently scrolling page. The fixed-viewport and dependency tests guard this contract.

## Compatible nested focus ownership

Dialog 1.1.23 and Select 2.3.7 use FocusScope 1.1.16. Popover 1.1.22 used a different focus stack and an API absent from 1.1.16. Simply forcing its internal FocusScope version is incompatible. The exact official Popover 1.1.23 release uses the matching API and shared focus owner; no focus-trap mocking, disabling or undocumented export shim is used.

The published Popover and FocusScope artifacts contain complete MIT licenses with the WorkOS attribution. Their exact locked integrity and licenses are independently checked along with the retained scroll package.

## Verification boundaries

- `FixedViewportScroll.test.tsx` exercises the actual installed Radix components: dialog content shards, background blocking, nested Select and modal Popover, allowed internal wheel/touch scrolling, pinch zoom, Escape/focus restoration, repeated opening and unmount cleanup
- `scrollbarDependency.test.ts` verifies removal from the lock and reachable dependency graph, one shared focus/scroll owner, public class-name compatibility, unchanged published event-handler bytes in all three module variants, and exact retained licenses
- `serverWebNotices.test.ts` continues to require complete notices and reject unknown or missing terms
- The native E2E regression checks real viewport geometry and scrolling. A jsdom event test is not evidence of native scrolling, layout, touch hardware or visual correctness

An old package directory can remain in pnpm's local content/virtual-store cache after removal. It must not be reachable in the selected graph or contribute to shipped output. Clean-install and actual emitted-module capture checks, rather than a text-only notice edit, establish removal from a candidate.

This source change does not approve an installer, release, native platform matrix or real-user workflow. Those remain separate validation gates.

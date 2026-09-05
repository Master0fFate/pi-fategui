import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantMarkdown } from './RichMessageContent';

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => { parse(children); return <p>{children}</p>; } }));

describe('unchanged assistant markdown', () => {
  it('does not parse again for unrelated parent renders, but updates changed text and images', () => {
    parse.mockClear();
    const view = render(<AssistantMarkdown text="Original answer" />);
    for (let index = 0; index < 20; index += 1) view.rerender(<AssistantMarkdown text="Original answer" />);
    expect(parse).toHaveBeenCalledTimes(1);
    view.rerender(<AssistantMarkdown text="Updated answer" />);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Updated answer')).toBeInTheDocument();
    view.rerender(<AssistantMarkdown text="Updated answer" images={[{ mimeType: 'image/png', data: 'aGVsbG8=', alt: 'Preview' }]} />);
    expect(screen.getByRole('button', { name: 'Expand image: Preview' })).toBeInTheDocument();
  });
});

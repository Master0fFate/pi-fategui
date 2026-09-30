import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuestionCard, type QuestionCardProps } from './QuestionCard';

const questionnaire: QuestionCardProps['questionnaire'] = {
  id: 'q1', sessionId: 's1', index: 0, total: 3,
  question: 'Which approach should we use?',
  options: [{ label: 'Small change', description: 'Keep the current design.' }, { label: 'New design' }, { label: 'Compare both' }],
};

describe('QuestionCard', () => {
  it('shows and focuses one original question with progress and option descriptions', () => {
    render(<QuestionCard questionnaire={questionnaire} onAnswer={vi.fn()} />);
    expect(screen.getByText('Question 1 / 3')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: questionnaire.question })).toHaveFocus();
    expect(screen.getByText('Keep the current design.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
  });

  it('limits the overlay to space above the rails and updates on viewport resize', () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 180 } as DOMRect);
    const { container, unmount } = render(
      <div className="composer-wrap">
        <div className="composer-rails"><QuestionCard questionnaire={questionnaire} onAnswer={vi.fn()} /></div>
        <textarea aria-label="Composer" />
      </div>,
    );
    try {
      const card = container.querySelector<HTMLElement>('.question-card')!;
      expect(card.style.getPropertyValue('--question-available-height')).toBe('164px');
      bounds.mockReturnValue({ top: 280 } as DOMRect);
      fireEvent(window, new Event('resize'));
      expect(card.style.getPropertyValue('--question-available-height')).toBe('264px');
      bounds.mockReturnValue({ top: 10 } as DOMRect);
      fireEvent(window, new Event('resize'));
      expect(card.style.getPropertyValue('--question-available-height')).toBe('0px');
    } finally {
      unmount();
      bounds.mockRestore();
    }
  });

  it('places three options and the custom field in one aligned list without a visible label', () => {
    render(<QuestionCard questionnaire={questionnaire} onAnswer={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Write your own answer...' });
    expect(input).toHaveAttribute('placeholder', 'Write your own answer...');
    expect(screen.queryByText('Write your own answer...')).not.toBeInTheDocument();
    const options = screen.getAllByRole('button');
    expect(options).toHaveLength(3);
    expect(input.parentElement).toHaveClass('question-card-options');
    expect(Array.from(input.parentElement!.children)).toEqual([...options, input]);
  });

  it('submits an option immediately and locks repeated clicks until the question changes', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<QuestionCard questionnaire={questionnaire} onAnswer={onAnswer} />);
    const option = screen.getByRole('button', { name: 'New design' });
    fireEvent.click(option);
    fireEvent.click(option);
    await act(async () => {});
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ id: 'q1', index: 0, answer: 'New design', source: 'option' });
    expect(option).toBeDisabled();
    rerender(<QuestionCard questionnaire={{ ...questionnaire, index: 1, question: 'Next question?' }} onAnswer={onAnswer} />);
    expect(screen.getByText('Question 2 / 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New design' })).toBeEnabled();
    expect(screen.queryByText(questionnaire.question)).not.toBeInTheDocument();
  });

  it('does not submit a clicked or blank custom field and trims Enter submissions', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<QuestionCard questionnaire={questionnaire} onAnswer={onAnswer} />);
    const input = screen.getByRole('textbox', { name: 'Write your own answer...' });
    expect(input).toHaveAttribute('maxlength', '2000');
    await user.click(input);
    expect(input).toHaveFocus();
    expect(onAnswer).not.toHaveBeenCalled();
    await user.type(input, '   {Enter}');
    expect(onAnswer).not.toHaveBeenCalled();
    await user.type(input, 'Something else  {Enter}');
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ id: 'q1', index: 0, answer: 'Something else', source: 'custom' });
  });

  it('supports keyboard options and unlocks after a failed submission', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined);
    render(<QuestionCard questionnaire={questionnaire} onAnswer={onAnswer} />);
    await user.tab();
    expect(screen.getByRole('button', { name: /Small change/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send answer. Try again.');
    await user.click(screen.getByRole('button', { name: 'New design' }));
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores IME Enter, preserves long option labels, and clears drafts across sessions', () => {
    const onAnswer = vi.fn();
    const label = 'Long option '.repeat(40);
    const question = 'Long question '.repeat(40);
    const description = 'Long description '.repeat(40);
    const { rerender } = render(<QuestionCard questionnaire={{ ...questionnaire, question, options: [{ label, description }] }} onAnswer={onAnswer} />);
    expect(screen.getByRole('heading')).toHaveTextContent(question.trim());
    expect(screen.getByRole('button')).toHaveTextContent(label.trim());
    expect(screen.getByRole('button')).toHaveTextContent(description.trim());
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Draft' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onAnswer).not.toHaveBeenCalled();
    rerender(<QuestionCard questionnaire={{ ...questionnaire, sessionId: 's2' }} onAnswer={onAnswer} />);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});

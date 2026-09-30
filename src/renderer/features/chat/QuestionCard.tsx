import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { PendingQuestionnaire, QuestionnaireAnswerInput } from '../../../shared/contracts/ipc';

export interface QuestionCardProps {
  questionnaire: PendingQuestionnaire;
  onAnswer: (input: QuestionnaireAnswerInput) => Promise<unknown>;
}

export function QuestionCard(props: QuestionCardProps) {
  const { id, sessionId, index } = props.questionnaire;
  return <CurrentQuestion key={JSON.stringify([sessionId, id, index])} {...props} />;
}

function CurrentQuestion({ questionnaire, onAnswer }: QuestionCardProps) {
  const headingId = useId();
  const progressId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const card = useRef<HTMLElement>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(false);

  useLayoutEffect(() => {
    const element = card.current;
    const rails = element?.closest<HTMLElement>('.composer-rails');
    const wrap = rails?.closest<HTMLElement>('.composer-wrap');
    if (!element || !rails || !wrap) return;
    const viewport = window.visualViewport;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(rails).getPropertyValue('--composer-rail-gap')) || 4;
      const available = rails.getBoundingClientRect().top - (viewport?.offsetTop ?? 0) - gap - 12;
      element.style.setProperty('--question-available-height', `${Math.max(0, available)}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(wrap);
    observer?.observe(rails);
    window.addEventListener('resize', measure);
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
    };
  }, []);

  useEffect(() => {
    mounted.current = true;
    heading.current?.focus({ preventScroll: true });
    return () => { mounted.current = false; };
  }, []);

  async function answer(value: string, source: 'option' | 'custom') {
    const text = source === 'custom' ? value.trim() : value;
    if (locked.current || !text.trim()) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    try {
      await onAnswer({ id: questionnaire.id, index: questionnaire.index, answer: text, source });
      // Stay locked until the parent advances or removes this question.
    } catch {
      if (!mounted.current) return;
      locked.current = false;
      setBusy(false);
      setError(true);
    }
  }

  return (
    <section ref={card} className="question-card" aria-labelledby={headingId} aria-describedby={progressId} aria-busy={busy}>
      <p className="question-card-progress" id={progressId}>Question {questionnaire.index + 1} / {questionnaire.total}</p>
      <h3 className="question-card-question" id={headingId} ref={heading} tabIndex={-1}>{questionnaire.question}</h3>
      <div className="question-card-options">
        {questionnaire.options.map((option, index) => (
          <button className="question-card-option" type="button" key={index} disabled={busy} onClick={() => void answer(option.label, 'option')}>
            <span>{option.label}</span>
            {option.description && <small>{option.description}</small>}
          </button>
        ))}
        <input
          className="question-card-custom"
          aria-label="Write your own answer..."
          value={draft}
          maxLength={2000}
          placeholder="Write your own answer..."
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            event.stopPropagation();
            void answer(draft, 'custom');
          }}
        />
      </div>
      {error && <p className="question-card-error" role="alert">Could not send answer. Try again.</p>}
    </section>
  );
}

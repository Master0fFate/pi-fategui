import { useEffect, useState } from 'react';
import './learning.css';
import { Brain } from 'lucide-react';
import { AppTooltip } from '../../components/AppTooltip';
import { useSkinComponents } from '../../skins/SkinProvider';
import { defaultMemoryLearning, type MemoryLearningSettings } from '../../../shared/contracts/learning';
import { useLearningStore } from './learningStore';

export function LearningIndicator() {
  const { ActionContent } = useSkinComponents();
  const [memory, setMemory] = useState<MemoryLearningSettings | null>(null);
  useEffect(() => {
    let current = true;
    const refresh = () => {
      if (!window.piDesktop?.getSettings) return;
      void window.piDesktop.getSettings().then((settings) => {
        if (current) setMemory(settings.memoryLearning ?? defaultMemoryLearning);
      }).catch(() => { if (current) setMemory(null); });
    };
    refresh();
    const unsubscribe = window.piDesktop?.onLearningChanged?.(refresh);
    return () => { current = false; unsubscribe?.(); };
  }, []);
  if (!memory?.enabled) return null;
  const modes = [memory.global ? 'GLOBAL' : null, memory.project ? 'PROJECT' : null].filter(Boolean).join(' · ') || 'None';
  return (
    <AppTooltip content={`Memory Learning · ${modes}`} wrapTrigger>
      <button type="button" className="learning-indicator" aria-label={`Memory Learning ${modes}`} onClick={() => useLearningStore.getState().show()}>
        <ActionContent text="m"><Brain size={14} /></ActionContent>
      </button>
    </AppTooltip>
  );
}

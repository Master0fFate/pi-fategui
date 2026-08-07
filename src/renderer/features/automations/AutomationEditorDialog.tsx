import * as Dialog from '@radix-ui/react-dialog';
import { Bot, FilePenLine, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_PROMPT_MAX_LENGTH,
  type AutomationCreateInput,
  type AutomationDefinition,
  type AutomationPermissionLevel,
} from '../../../shared/contracts/automations';

interface AutomationEditorDialogProps {
  open: boolean;
  automation: AutomationDefinition | null;
  saving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (input: AutomationCreateInput) => Promise<void>;
}

export function AutomationEditorDialog({
  open,
  automation,
  saving,
  error,
  onOpenChange,
  onSave,
}: AutomationEditorDialogProps) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [permissionLevel, setPermissionLevel] = useState<AutomationPermissionLevel>('read-only');

  useEffect(() => {
    if (!open) return;
    setName(automation?.name ?? '');
    setPrompt(automation?.prompt ?? '');
    setPermissionLevel(automation?.permissionLevel ?? 'read-only');
  }, [automation, open]);

  const valid = name.trim().length > 0 && prompt.trim().length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="automation-editor" aria-describedby="automation-editor-description">
          <header>
            <span className="automation-editor-mark" aria-hidden="true"><Bot size={17} /></span>
            <span>
              <Dialog.Title>{automation ? 'Edit automation' : 'New automation'}</Dialog.Title>
              <Dialog.Description id="automation-editor-description">Save a repeatable prompt for this project.</Dialog.Description>
            </span>
            <Dialog.Close aria-label="Close automation editor" disabled={saving}><X size={16} /></Dialog.Close>
          </header>

          <form onSubmit={(event) => {
            event.preventDefault();
            if (!saving && valid) void onSave({ name, prompt, permissionLevel });
          }}>
            <label className="automation-field">
              <span>Name</span>
              <input
                autoFocus
                value={name}
                maxLength={AUTOMATION_NAME_MAX_LENGTH}
                placeholder="Review the current changes"
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            <label className="automation-field automation-prompt-field">
              <span>Prompt</span>
              <textarea
                value={prompt}
                maxLength={AUTOMATION_PROMPT_MAX_LENGTH}
                placeholder="Describe the repeatable task clearly, including its expected checks."
                onChange={(event) => setPrompt(event.target.value)}
              />
              <small>{prompt.length.toLocaleString()} / {AUTOMATION_PROMPT_MAX_LENGTH.toLocaleString()}</small>
            </label>

            <fieldset className="automation-permission">
              <legend>Project access</legend>
              <button
                type="button"
                data-active={permissionLevel === 'read-only'}
                aria-pressed={permissionLevel === 'read-only'}
                onClick={() => setPermissionLevel('read-only')}
              >
                <ShieldCheck size={14} /><span><strong>Read only</strong><small>Inspect without changing files</small></span>
              </button>
              <button
                type="button"
                data-active={permissionLevel === 'edit'}
                aria-pressed={permissionLevel === 'edit'}
                onClick={() => setPermissionLevel('edit')}
              >
                <FilePenLine size={14} /><span><strong>Edit project</strong><small>Allow project-confined edits</small></span>
              </button>
            </fieldset>

            {error && <div className="automation-editor-error" role="alert">{error}</div>}
            <footer>
              <Dialog.Close type="button" disabled={saving}>Cancel</Dialog.Close>
              <button className="automation-save" type="submit" disabled={!valid || saving}>{saving ? 'Saving…' : automation ? 'Save changes' : 'Create automation'}</button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
